import axios from 'axios';
import nodemailer from 'nodemailer';
import { SLACK_DELAY_WEBHOOK, SLACK_ERROR_WEBHOOK, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } from './config';

// ─── Slack ────────────────────────────────────────────────────────────────────

async function postToSlack(webhookUrl: string, text: string): Promise<void> {
  if (!webhookUrl) {
    console.warn('[Slack] No webhook URL configured, skipping.');
    return;
  }
  try {
    await axios.post(webhookUrl, { text }, { timeout: 10_000 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Slack] POST failed: ${message}`);
  }
}

/**
 * Slack: LKW ist noch nicht abgefahren, baut Verspätung auf ("Delay is Building")
 */
export async function sendSlackDelayBuilding(row: {
  Ladereferenz: string;
  Carrier?: string;
  planDatum?: string;
  planUhrzeit?: string;
}): Promise<void> {
  const text =
    `${row.Ladereferenz}\n` +
    `${row.Carrier ?? ''}\n` +
    `Abfahrt Soll: ${row.planUhrzeit ?? ''}, ${row.planDatum ?? ''}\n` +
    `Abfahrt Ist: Noch nicht abgefahren\n` +
    `Verspätungsgrund: Ausstehend\n` +
    `Verspätung: Laufend...\n\n` +
    `🚨 Bitte Trailer schnellstmöglich abfahren lassen und den Verspätungsgrund eintragen.`;

  await postToSlack(SLACK_DELAY_WEBHOOK, text);
}

/**
 * Slack: LKW ist verspätet abgefahren ("Final Delay")
 */
export async function sendSlackFinalDelay(row: {
  Ladereferenz: string;
  Carrier?: string;
  planDatum?: string;
  planUhrzeit?: string;
  istDatum?: string;
  istUhrzeit?: string;
  grund?: string;
  delayString: string;
}): Promise<void> {
  const hasGrund = row.grund && row.grund.trim() !== '';
  const text =
    `${row.Ladereferenz}\n` +
    `${row.Carrier ?? ''}\n` +
    `Abfahrt Soll: ${row.planUhrzeit ?? ''}, ${row.planDatum ?? ''}\n` +
    `Abfahrt Ist: ${row.istUhrzeit ?? ''}, ${row.istDatum ?? ''}\n` +
    `Verspätungsgrund: ${row.grund ?? ''}\n` +
    `Verspätung: ${row.delayString}` +
    (!hasGrund ? '\n\n🚨 Bitte den Verspätungsgrund nachtragen' : '');

  await postToSlack(SLACK_DELAY_WEBHOOK, text);
}

/**
 * Slack: Error-Alert wenn der Prozess abstürzt
 */
export async function sendSlackErrorAlert(error: string, context?: string): Promise<void> {
  if (!SLACK_ERROR_WEBHOOK) return;
  const text =
    `🔴 *DACH Delay Monitor – Fehler*\n` +
    `${context ? `Kontext: ${context}\n` : ''}` +
    `Fehler: ${error}\n` +
    `Zeit: ${new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}`;
  await postToSlack(SLACK_ERROR_WEBHOOK, text);
}

// ─── Email ────────────────────────────────────────────────────────────────────

let _transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: false,
      requireTLS: true,
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASS,
      },
    });
  }
  return _transporter;
}

/**
 * Email: Verspätungswarnung mit berechneter ETA
 */
export async function sendDelayEmail(params: {
  toEmail: string;
  ladereferenz: string;
  carrier?: string;
  fahrerTel?: string;
  scheduledArrival: string;
  calculatedEta: string;
}): Promise<void> {
  const transporter = getTransporter();

  const text =
    `Hallo Team,\n\n` +
    `der folgende LKW befindet sich aktuell auf dem Weg, wird sein geplantes Ankunftsfenster am Zielort aber voraussichtlich verpassen.\n\n` +
    `Hier sind die aktuellen Streckendaten:\n\n` +
    `Ladereferenz: ${params.ladereferenz}\n` +
    `Transportdienstleister: ${params.carrier ?? 'Nicht angegeben'}\n` +
    `Telefonnummer Fahrer: ${params.fahrerTel ?? 'Nicht hinterlegt'}\n` +
    `Geplante Ankunft: ${params.scheduledArrival}\n` +
    `Voraussichtliche Ankunft (Live-Traffic): ${params.calculatedEta}\n\n` +
    `Bitte berücksichtigt diese Verzögerung in der weiteren Planung und Vorbereitung.\n\n` +
    `Viele Grüße`;

  try {
    await transporter.sendMail({
      from: SMTP_FROM,
      to: params.toEmail,
      subject: `⚠️ Verspätungswarnung: ${params.ladereferenz}`,
      text,
    });
    console.log(`[Email] Sent delay warning for ${params.ladereferenz} to ${params.toEmail}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Email] Failed for ${params.ladereferenz}: ${message}`);
    throw err;
  }
}
