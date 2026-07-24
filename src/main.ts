import 'dotenv/config';
import { DateTime } from 'luxon';
import { WA_LIST_SHEET_IDS, FINAL_DELAY_THRESHOLD_MINUTES, TIMEZONE } from './config';
import { readWaListe, readMappings, readTracking, updateTracking, TrackingRow, SheetRow } from './sheets';
import { processTrucks, formatEta, isArrivalAtRisk, parseActualDeparture, parsePlannedArrival } from './processor';
import { getTruckTravelTime } from './tomtom';
import {
  sendSlackDelayBuilding,
  sendSlackFinalDelay,
  sendDelayEmail,
  sendSlackErrorAlert,
} from './notifier';

// ─── Run counter for error alerting ──────────────────────────────────────────
let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 2;

async function run(): Promise<void> {
  const runStart = Date.now();
  const now = DateTime.now().setZone(TIMEZONE);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[Main] Run started at ${now.toFormat('dd.MM.yyyy HH:mm:ss')} (${TIMEZONE})`);

  // ── 1. Fetch all reference data ─────────────────────────────────────────────
  console.log('[Main] Fetching mappings and tracking data...');
  const [mappings, trackingRows] = await Promise.all([
    readMappings(),
    readTracking(),
  ]);

  const trackingMap = new Map<string, TrackingRow>();
  for (const t of trackingRows) {
    if (t.Ladereferenz) trackingMap.set(t.Ladereferenz.trim(), t);
  }
  console.log(`[Main] Loaded ${mappings.length} mappings, ${trackingRows.length} tracking rows`);

  // ── 2. Fetch all WA-Lists ───────────────────────────────────────────────────
  console.log(`[Main] Fetching ${WA_LIST_SHEET_IDS.length} WA-Liste sheets...`);
  const allRows: SheetRow[] = [];

  const waResults = await Promise.allSettled(
    WA_LIST_SHEET_IDS.map(id => readWaListe(id))
  );

  for (let i = 0; i < waResults.length; i++) {
    const result = waResults[i];
    if (result.status === 'fulfilled') {
      allRows.push(...result.value);
      console.log(`[Main] Sheet ${i + 1}/${WA_LIST_SHEET_IDS.length}: ${result.value.length} rows`);
    } else {
      console.error(`[Main] Sheet ${i + 1}/${WA_LIST_SHEET_IDS.length} FAILED: ${result.reason}`);
    }
  }
  console.log(`[Main] Total rows loaded: ${allRows.length}`);

  // ── 3. Process trucks ───────────────────────────────────────────────────────
  const trucks = processTrucks(allRows, mappings, trackingMap);
  console.log(`[Main] Relevant trucks after filtering: ${trucks.length}`);

  let notifiedCount = 0;

  for (const truck of trucks) {
    const { ladereferenz } = truck;

    // ── Case A: Truck hasn't left yet, is 10+ min late ──────────────────────
    if (truck.is10MinsLate && !truck.warningSent) {
      console.log(`[Main] [WARNING] ${ladereferenz} – not departed, 10+ min late`);
      try {
        await sendSlackDelayBuilding({
          Ladereferenz: ladereferenz,
          Carrier: truck.carrier,
          planDatum: truck.planDatum,
          planUhrzeit: truck.planUhrzeit,
        });
        await updateTracking(ladereferenz, { Warning_Sent: 'TRUE', Final_Delay_Sent: 'FALSE' });
        notifiedCount++;
        console.log(`[Main] ✓ Warning sent for ${ladereferenz}`);
      } catch (err) {
        console.error(`[Main] Failed to send warning for ${ladereferenz}: ${err}`);
      }
    }

    // ── Case B: Truck departed late ─────────────────────────────────────────
    if (truck.leftLate && !truck.finalDelaySent) {
      console.log(`[Main] [FINAL DELAY] ${ladereferenz} – departed ${truck.delayString} late`);

      try {
        // Sub-case B1: Delay > 30 min → Slack Final Delay (no ETA email needed)
        if (truck.delayMinutes > FINAL_DELAY_THRESHOLD_MINUTES) {
          await sendSlackFinalDelay({
            Ladereferenz: ladereferenz,
            Carrier: truck.carrier,
            planDatum: truck.planDatum,
            planUhrzeit: truck.planUhrzeit,
            istDatum: truck.istDatum,
            istUhrzeit: truck.istUhrzeit,
            grund: truck.grund,
            delayString: truck.delayString,
          });
          await updateTracking(ladereferenz, { Warning_Sent: 'TRUE', Final_Delay_Sent: 'TRUE' });
          notifiedCount++;
          console.log(`[Main] ✓ Final delay Slack sent for ${ladereferenz}`);
        }

        // Sub-case B2: Has coordinates → TomTom ETA + Email if at risk
        if (truck.originCoords && truck.destCoords) {
          const actualDep = parseActualDeparture(truck.raw);
          const plannedArr = parsePlannedArrival(truck.raw);

          const tomtom = await getTruckTravelTime(truck.originCoords, truck.destCoords);

          if (tomtom.found && actualDep) {
            const calculatedEta = formatEta(actualDep, tomtom.travelTimeInSeconds);
            const atRisk = isArrivalAtRisk(actualDep, tomtom.travelTimeInSeconds, plannedArr);

            console.log(`[Main] TomTom ETA for ${ladereferenz}: ${calculatedEta} | At risk: ${atRisk}`);

            if (atRisk && truck.email && !truck.emailSent) {
              const plannedArrStr = plannedArr
                ? plannedArr.toFormat('dd.MM.yyyy HH:mm')
                : 'Unbekannt';

              await sendDelayEmail({
                toEmail: truck.email,
                ladereferenz,
                carrier: truck.carrier,
                fahrerTel: truck.fahrerTel,
                scheduledArrival: plannedArrStr,
                calculatedEta,
              });
              await updateTracking(ladereferenz, { Email_Sent: 'TRUE' });
              notifiedCount++;
              console.log(`[Main] ✓ Delay email sent for ${ladereferenz} to ${truck.email}`);
            }
          }

          // If delay ≤ 30 min → also mark final delay after ETA check
          if (truck.delayMinutes <= FINAL_DELAY_THRESHOLD_MINUTES && !truck.finalDelaySent) {
            await updateTracking(ladereferenz, { Warning_Sent: 'TRUE', Final_Delay_Sent: 'TRUE' });
          }
        } else if (truck.delayMinutes <= FINAL_DELAY_THRESHOLD_MINUTES && !truck.finalDelaySent) {
          // No coords and ≤ 30 min → just mark as processed
          await updateTracking(ladereferenz, { Warning_Sent: 'TRUE', Final_Delay_Sent: 'TRUE' });
        }

      } catch (err) {
        console.error(`[Main] Error processing final delay for ${ladereferenz}: ${err}`);
      }
    }
  }

  const elapsed = ((Date.now() - runStart) / 1000).toFixed(1);
  console.log(`[Main] Run finished in ${elapsed}s. Notifications sent: ${notifiedCount}`);
  consecutiveErrors = 0; // reset on success
}

// ─── Entry point ──────────────────────────────────────────────────────────────

run().catch(async (err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[Main] FATAL ERROR: ${message}`);
  consecutiveErrors++;

  if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
    await sendSlackErrorAlert(message, `Run failed ${consecutiveErrors} times in a row`);
  }

  process.exit(1);
});
