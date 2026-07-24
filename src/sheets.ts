import axios from 'axios';
import { MAPPING_SHEET_ID, MAPPING_SHEET_TAB, TRACKING_SHEET_ID, TRACKING_SHEET_TAB } from './config';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SheetRow {
  [key: string]: string;
}

export interface TrackingRow {
  Ladereferenz?: string;
  Warning_Sent?: string;
  Final_Delay_Sent?: string;
  Email_Sent?: string;
}

export interface MappingRow {
  Substring?: string;
  Slack_Tag?: string;
  Slack_tagg?: string;
  Email?: string;
  Origin_Coords?: string;
  Dest_Coords?: string;
}

// ─── Auth token fetcher ───────────────────────────────────────────────────────
// Nutzt den dach-ai-mvps OAuth Token aus dem Skill (~/.cursor/google_workspace_token.json)
// Im Cloud Run Kontext: Service Account via GOOGLE_APPLICATION_CREDENTIALS

let _accessToken: string | null = null;
let _tokenExpiry = 0;

async function getAccessToken(): Promise<string> {
  // Cloud Run: Service Account via metadata server
  if (process.env.K_SERVICE) {
    const now = Date.now();
    if (_accessToken && now < _tokenExpiry - 60_000) return _accessToken;

    const res = await axios.get(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' } }
    );
    _accessToken = res.data.access_token as string;
    _tokenExpiry = now + (res.data.expires_in as number) * 1000;
    return _accessToken;
  }

  // GitHub Actions / CI: Refresh Token direkt als Umgebungsvariable
  if (process.env.GOOGLE_REFRESH_TOKEN) {
    const now = Date.now();
    if (_accessToken && now < _tokenExpiry - 60_000) return _accessToken;

    const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
    const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
    if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set');

    const refreshRes = await axios.post('https://oauth2.googleapis.com/token', {
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type:    'refresh_token',
    });
    _accessToken = refreshRes.data.access_token as string;
    _tokenExpiry = now + (refreshRes.data.expires_in as number) * 1000;
    return _accessToken;
  }

  // Lokal: Token aus dem Skill-Auth-Script lesen
  // GOOGLE_TOKEN_PATH kann explizit gesetzt werden (z.B. mit 8.3-Kurzpfad bei Umlaut-Username)
  let tokenPath = process.env.GOOGLE_TOKEN_PATH ?? '';

  if (!tokenPath) {
    // Versuche Standard-Pfade in Reihenfolge
    const candidates = [
      process.env.USERPROFILE ? `${process.env.USERPROFILE}\\.cursor\\google_workspace_token.json` : '',
      process.env.HOME        ? `${process.env.HOME}/.cursor/google_workspace_token.json`          : '',
    ];
    const fs2 = await import('fs');
    for (const c of candidates) {
      if (c && fs2.existsSync(c)) { tokenPath = c; break; }
    }
    // Windows fallback: APPDATA -> .cursor sibling
    if (!tokenPath && process.env.APPDATA) {
      const via = process.env.APPDATA.replace(/\\Roaming$/i, '\\.cursor\\google_workspace_token.json');
      if (fs2.existsSync(via)) tokenPath = via;
    }
    if (!tokenPath) {
      throw new Error(
        'Google token file not found. Set GOOGLE_TOKEN_PATH in .env to the full path of ' +
        'google_workspace_token.json, or run the google_auth.py script first.'
      );
    }
  }

  const fs = await import('fs');
  const raw = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));

  const now = Date.now();
  if (raw.access_token && raw.expiry_date && now < raw.expiry_date - 60_000) {
    return raw.access_token as string;
  }

  // Token abgelaufen → refreshen
  // Das Skill-Script (google_auth.py) speichert: { refresh_token, client_id }
  // Der CLIENT_SECRET aus dem Skill-Script ist öffentlich (Shared Desktop App)
  const SHARED_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? '';

  const refreshRes = await axios.post('https://oauth2.googleapis.com/token', {
    client_id: raw.client_id,
    client_secret: raw.client_secret ?? SHARED_CLIENT_SECRET,
    refresh_token: raw.refresh_token,
    grant_type: 'refresh_token',
  });

  const newToken = {
    ...raw,
    access_token: refreshRes.data.access_token,
    expiry_date: now + refreshRes.data.expires_in * 1000,
  };
  fs.writeFileSync(tokenPath, JSON.stringify(newToken, null, 2));
  return newToken.access_token as string;
}

// ─── Sheets API helpers ───────────────────────────────────────────────────────

async function sheetsGet(spreadsheetId: string, range: string): Promise<string[][]> {
  const token = await getAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`;
  const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
  return (res.data.values as string[][]) ?? [];
}

async function sheetsAppendOrUpdate(
  spreadsheetId: string,
  sheetTab: string,
  matchColumn: string,
  matchValue: string,
  updates: Record<string, string>
): Promise<void> {
  const token = await getAccessToken();

  // 1. Fetch all data to find the row
  const values = await sheetsGet(spreadsheetId, `${sheetTab}!A1:Z1000`);
  if (values.length === 0) return;

  const headers = values[0];
  const matchColIdx = headers.indexOf(matchColumn);
  if (matchColIdx === -1) throw new Error(`Column "${matchColumn}" not found in ${sheetTab}`);

  let rowIndex = -1;
  for (let i = 1; i < values.length; i++) {
    if ((values[i][matchColIdx] ?? '').trim() === matchValue.trim()) {
      rowIndex = i + 1; // 1-based sheet row
      break;
    }
  }

  if (rowIndex === -1) {
    // Append new row
    const newRow = headers.map(h => updates[h] ?? (h === matchColumn ? matchValue : ''));
    const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetTab + '!A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
    await axios.post(appendUrl, { values: [newRow] }, { headers: { Authorization: `Bearer ${token}` } });
  } else {
    // Update existing row cell by cell
    for (const [col, val] of Object.entries(updates)) {
      const colIdx = headers.indexOf(col);
      if (colIdx === -1) continue;
      const colLetter = columnIndexToLetter(colIdx);
      const cellRange = `${sheetTab}!${colLetter}${rowIndex}`;
      const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(cellRange)}?valueInputOption=RAW`;
      await axios.put(updateUrl, { values: [[val]] }, { headers: { Authorization: `Bearer ${token}` } });
    }
  }
}

function columnIndexToLetter(index: number): string {
  let letter = '';
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Reads a Google Sheet and returns rows as key-value objects using the header row.
 * headerRowIndex: 0-based index of the header row (default 0)
 * dataStartRow: 0-based index of first data row (default 1)
 */
export async function readSheet(
  spreadsheetId: string,
  sheetTab: string,
  headerRowIndex = 0,
  dataStartRow = 1
): Promise<SheetRow[]> {
  const values = await sheetsGet(spreadsheetId, `${sheetTab}!A1:Z2000`);
  if (values.length <= headerRowIndex) return [];

  const headers = values[headerRowIndex];
  const rows: SheetRow[] = [];

  for (let i = dataStartRow; i < values.length; i++) {
    const row: SheetRow = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[i][j] ?? '';
    }
    rows.push(row);
  }
  return rows;
}

/** Reads the mapping sheet (Team-Tags, Emails, Koordinaten) */
export async function readMappings(): Promise<MappingRow[]> {
  return (await readSheet(MAPPING_SHEET_ID, MAPPING_SHEET_TAB)) as MappingRow[];
}

/** Reads the tracking sheet (already-sent notification flags) */
export async function readTracking(): Promise<TrackingRow[]> {
  return (await readSheet(TRACKING_SHEET_ID, TRACKING_SHEET_TAB)) as TrackingRow[];
}

/** Marks Warning_Sent and/or Final_Delay_Sent and/or Email_Sent for a Ladereferenz */
export async function updateTracking(
  ladereferenz: string,
  updates: Partial<{ Warning_Sent: string; Final_Delay_Sent: string; Email_Sent: string }>
): Promise<void> {
  const stringUpdates: Record<string, string> = {};
  for (const [k, v] of Object.entries(updates)) {
    if (v !== undefined) stringUpdates[k] = v;
  }
  await sheetsAppendOrUpdate(
    TRACKING_SHEET_ID,
    TRACKING_SHEET_TAB,
    'Ladereferenz',
    ladereferenz,
    stringUpdates
  );
}

/** Reads a WA-Liste sheet (header row 3, data row 4 → 0-based: 2 and 3) */
export async function readWaListe(sheetId: string): Promise<SheetRow[]> {
  return readSheet(sheetId, 'WA Liste', 2, 3);
}
