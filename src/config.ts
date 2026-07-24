import * as dotenv from 'dotenv';
dotenv.config();

// ─── Google Sheets IDs ────────────────────────────────────────────────────────
// Die 6 WA-Listen (GoodsOut) – eine pro Werk/Standort
export const WA_LIST_SHEET_IDS: string[] = [
  '1FeU9pv4rgYzZiPPUHEBGCkJDr2LS6NeRy4kGxoCHLS0',
  '1fLloJA1c_0QAag-dFj89dvZ3yz1Q3bAFaQPDcG_n3GI',
  '1n2YwiAz9FAhtlmcXde-ciiGWmIhjGYEJ60lcBjYU0c0',
  '1YbTDy7GFQ6gO0tinCon2w2c7O0NZaXMZzuBHhq_H3Xg',
  '1n8c3OOUg5fXxVXu08lQd96VnuUaN3R1W0PFxcM_EGXs',
  '1RMkAebaHaERlqaXLykHYHL1R6-frJeJYunJHArFkhw0',
];

// Mapping Sheet: Team-Tags, Emails, Koordinaten pro Route-Substring
export const MAPPING_SHEET_ID = '1Py3TcQrR6_j9oAdcpNh36k49vla9YNpYTjb08exEm6Y';
export const MAPPING_SHEET_TAB = 'Tagging';

// Tracking Sheet: Welche Meldungen wurden bereits gesendet?
export const TRACKING_SHEET_ID = '15q5B4yGTlYI-nAU5Yz_Vt8oW8QrWta381xXhMDB36Pk';
export const TRACKING_SHEET_TAB = 'Verspätungen';

// ─── APIs ─────────────────────────────────────────────────────────────────────
export const TOMTOM_API_KEY = process.env.TOMTOM_API_KEY ?? 'Ag6UjMAOLM0Ba2BcTAWt3ld4hT9BnlLr';

// Slack Webhook URLs
export const SLACK_DELAY_WEBHOOK = process.env.SLACK_DELAY_WEBHOOK ?? 'https://hooks.slack.com/triggers/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';
export const SLACK_ERROR_WEBHOOK = process.env.SLACK_ERROR_WEBHOOK ?? '';

// ─── SMTP ─────────────────────────────────────────────────────────────────────
export const SMTP_HOST    = process.env.SMTP_HOST    ?? 'smtp.gmail.com';
export const SMTP_PORT    = parseInt(process.env.SMTP_PORT ?? '587');
export const SMTP_USER    = process.env.SMTP_USER    ?? 'actuals_dach_logistics@hellofresh.de';
export const SMTP_PASS    = process.env.SMTP_PASS    ?? 'mcwf tzzx njee gkmy';
export const SMTP_FROM    = process.env.SMTP_FROM    ?? 'actuals_dach_logistics@hellofresh.de';

// ─── Timeouts & Logic ─────────────────────────────────────────────────────────
export const DELAY_THRESHOLD_MINUTES = 10;   // Truck not departed → warn after 10 min late
export const FINAL_DELAY_THRESHOLD_MINUTES = 30; // Departed late → "Final Delay" Slack if > 30 min
export const MAX_LOOKBACK_DAYS = 2;           // Only process rows from last N days
export const TIMEZONE = 'Europe/Berlin';
