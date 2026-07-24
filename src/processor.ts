import { DateTime } from 'luxon';
import { SheetRow, MappingRow, TrackingRow } from './sheets';
import { TIMEZONE, DELAY_THRESHOLD_MINUTES, FINAL_DELAY_THRESHOLD_MINUTES, MAX_LOOKBACK_DAYS } from './config';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TruckStatus {
  raw: SheetRow;
  ladereferenz: string;
  carrier: string;
  fahrerTel: string;
  kommentar: string;

  // Parsed times
  planDatum: string;
  planUhrzeit: string;
  istDatum: string;
  istUhrzeit: string;
  grund: string;

  // Computed
  is10MinsLate: boolean;   // Not departed yet, 10+ min past scheduled departure
  leftLate: boolean;       // Departed, but later than scheduled
  delayMinutes: number;    // How many minutes late (if leftLate)
  delayString: string;     // HH:MM format

  // From mapping
  teamTag: string;
  email: string;
  originCoords: string;
  destCoords: string;

  // From tracking sheet
  warningSent: boolean;
  finalDelaySent: boolean;
  emailSent: boolean;
}

// ─── Date parsing ─────────────────────────────────────────────────────────────

function parseDateTime(dateStr: string, timeStr: string): DateTime | null {
  if (!dateStr || !timeStr) return null;
  const clean = (s: string) => s.trim();
  const dt = DateTime.fromFormat(
    `${clean(dateStr)} ${clean(timeStr)}`,
    'dd.MM.yyyy HH:mm',
    { zone: TIMEZONE }
  );
  return dt.isValid ? dt : null;
}

function formatDt(dt: DateTime): string {
  return dt.toFormat('dd.MM.yyyy HH:mm');
}

// ─── Mapping lookup ───────────────────────────────────────────────────────────

function lookupMapping(ladereferenz: string, mappings: MappingRow[]) {
  for (const m of mappings) {
    if (m.Substring && ladereferenz.includes(m.Substring)) {
      return {
        teamTag: m.Slack_tagg ?? m.Slack_Tag ?? '',
        email: m.Email ?? '',
        originCoords: (m.Origin_Coords ?? '').replace(/\s+/g, ''),
        destCoords: (m.Dest_Coords ?? '').replace(/\s+/g, ''),
      };
    }
  }
  return { teamTag: '', email: '', originCoords: '', destCoords: '' };
}

// ─── Filter checks ────────────────────────────────────────────────────────────

function isRowRelevant(row: SheetRow): boolean {
  const ref = (row['Ladereferenz'] ?? '').trim();
  if (!ref) return false;
  if (ref.toLowerCase().includes('kombiniert')) return false;
  if (ref.toUpperCase().startsWith('VE')) return false;
  if (ref.includes('304-HAN')) return false;
  if (ref.toLowerCase().includes('eiskiste')) return false;

  const kommentar = (row['Kommentar'] ?? '').trim();
  if (kommentar === 'Storniert') return false;

  // Only rows within the last MAX_LOOKBACK_DAYS
  const planDate = row['ON TIME DEPARTURE (PLAN)\nDatum'] ?? row['ON TIME DEPARTURE (PLAN)\r\nDatum'] ?? '';
  if (planDate) {
    const dt = DateTime.fromFormat(planDate.trim(), 'dd.MM.yyyy', { zone: TIMEZONE });
    if (dt.isValid) {
      const cutoff = DateTime.now().setZone(TIMEZONE).minus({ days: MAX_LOOKBACK_DAYS }).startOf('day');
      if (dt < cutoff) return false;
    }
  }

  return true;
}

// ─── Main processor ───────────────────────────────────────────────────────────

export function processTrucks(
  rows: SheetRow[],
  mappings: MappingRow[],
  trackingMap: Map<string, TrackingRow>
): TruckStatus[] {
  const now = DateTime.now().setZone(TIMEZONE);
  const results: TruckStatus[] = [];

  for (const row of rows) {
    if (!isRowRelevant(row)) continue;

    const ladereferenz = (row['Ladereferenz'] ?? '').trim();

    // Get column names (handles \n or \r\n line separators from Sheets)
    const getCol = (base: string) => {
      for (const key of Object.keys(row)) {
        if (key.replace(/\r?\n/g, '\n').startsWith(base)) return row[key] ?? '';
      }
      return '';
    };

    const planDatum   = getCol('ON TIME DEPARTURE (PLAN)\nDatum').trim();
    const planUhrzeit = getCol('ON TIME DEPARTURE (PLAN)\nUhrzeit').trim();
    const istDatum    = getCol('ON TIME DEPARTURE (IST)\nDatum').trim();
    const istUhrzeit  = getCol('ON TIME DEPARTURE (IST)\nUhrzeit').trim();
    const grund       = getCol('ON TIME DEPARTURE (IST)\nGrund').trim();
    const arrivalPlanDatum   = getCol('ON TIME ARRIVAL HUB (PLAN)\nDatum').trim();
    const arrivalPlanUhrzeit = getCol('ON TIME ARRIVAL HUB (PLAN)\nUhrzeit').trim();

    const scheduledDeparture = parseDateTime(planDatum, planUhrzeit);
    const actualDeparture    = parseDateTime(istDatum, istUhrzeit);
    const plannedArrival     = parseDateTime(arrivalPlanDatum, arrivalPlanUhrzeit);

    let is10MinsLate = false;
    let leftLate = false;
    let delayMinutes = 0;
    let delayString = '';

    if (scheduledDeparture) {
      const diffFromNow = now.diff(scheduledDeparture, 'minutes').minutes;

      if (!actualDeparture && diffFromNow >= DELAY_THRESHOLD_MINUTES) {
        is10MinsLate = true;
      }

      if (actualDeparture && actualDeparture > scheduledDeparture) {
        leftLate = true;
        delayMinutes = Math.floor(actualDeparture.diff(scheduledDeparture, 'minutes').minutes);
        const h = Math.floor(delayMinutes / 60);
        const m = delayMinutes % 60;
        delayString = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      }
    }

    const mapping = lookupMapping(ladereferenz, mappings);
    const tracking = trackingMap.get(ladereferenz);

    const status: TruckStatus = {
      raw: row,
      ladereferenz,
      carrier: (row['Carrier'] ?? row['Transportunternehmen'] ?? '').trim(),
      fahrerTel: (row['Fahrer_Tel'] ?? row['Fahrer Tel'] ?? '').trim(),
      kommentar: (row['Kommentar'] ?? '').trim(),
      planDatum,
      planUhrzeit,
      istDatum,
      istUhrzeit,
      grund,
      is10MinsLate,
      leftLate,
      delayMinutes,
      delayString,
      ...mapping,
      warningSent:    tracking?.Warning_Sent    === 'TRUE',
      finalDelaySent: tracking?.Final_Delay_Sent === 'TRUE',
      emailSent:      tracking?.Email_Sent       === 'TRUE',
    };

    results.push(status);
  }

  return results;
}

export function formatEta(departureTime: DateTime, travelSeconds: number): string {
  return formatDt(departureTime.plus({ seconds: travelSeconds }));
}

export function isArrivalAtRisk(
  departureTime: DateTime,
  travelSeconds: number,
  plannedArrival: DateTime | null
): boolean {
  if (!plannedArrival || travelSeconds === 0) return false;
  return departureTime.plus({ seconds: travelSeconds }) > plannedArrival;
}

export function parsePlannedArrival(row: SheetRow): DateTime | null {
  const getCol = (base: string) => {
    for (const key of Object.keys(row)) {
      if (key.replace(/\r?\n/g, '\n').startsWith(base)) return row[key] ?? '';
    }
    return '';
  };
  const datum   = getCol('ON TIME ARRIVAL HUB (PLAN)\nDatum').trim();
  const uhrzeit = getCol('ON TIME ARRIVAL HUB (PLAN)\nUhrzeit').trim();
  if (!datum || !uhrzeit) return null;
  const dt = DateTime.fromFormat(`${datum} ${uhrzeit}`, 'dd.MM.yyyy HH:mm', { zone: TIMEZONE });
  return dt.isValid ? dt : null;
}

export function parseActualDeparture(row: SheetRow): DateTime | null {
  const getCol = (base: string) => {
    for (const key of Object.keys(row)) {
      if (key.replace(/\r?\n/g, '\n').startsWith(base)) return row[key] ?? '';
    }
    return '';
  };
  const datum   = getCol('ON TIME DEPARTURE (IST)\nDatum').trim();
  const uhrzeit = getCol('ON TIME DEPARTURE (IST)\nUhrzeit').trim();
  if (!datum || !uhrzeit) return null;
  const dt = DateTime.fromFormat(`${datum} ${uhrzeit}`, 'dd.MM.yyyy HH:mm', { zone: TIMEZONE });
  return dt.isValid ? dt : null;
}
