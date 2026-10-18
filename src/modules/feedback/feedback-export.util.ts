import { type FeedbackListEntry } from './feedback-admin.service.js';

// ─────────────────────────────────────────
//  FEEDBACK EXPORT — the super admin list as CSV
//
//  Organisers typed the answers, so every cell is CSV-quoted as needed AND
//  defused for spreadsheets: a value starting with =, +, -, @, tab or
//  carriage return is prefixed with an apostrophe, or Excel and Sheets
//  would run it as a formula on the super admin's machine. A UTF-8 byte
//  order mark lets Excel read accents and emoji correctly.
// ─────────────────────────────────────────

const FORMULA_START = /^[=+\-@\t\r]/;

export const csvCell = (value: string | number | null): string => {
  if (value === null) return '';
  let text = String(value);
  if (typeof value === 'string' && FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const day = (date: Date | null): string => (date ? date.toISOString().slice(0, 10) : '');

const permissionCell = (p: FeedbackListEntry['permissions'][keyof FeedbackListEntry['permissions']]): string => {
  if (p.status === 'GRANTED') return `Granted ${day(p.givenAt)} (wording v${p.wordingVersion})`;
  if (p.status === 'WITHDRAWN') return `WITHDRAWN ${day(p.withdrawnAt)} (given ${day(p.givenAt)}, wording v${p.wordingVersion})`;
  return 'Not given';
};

const HEADER = [
  'Event',
  'Company',
  'Event date',
  'Submitted',
  'Last updated',
  'Score',
  'What worked best',
  'What to improve',
  'Logo',
  'Company name and logo',
  'Quote',
  'Case study contact',
  'Selected photos',
  'Shareable photos',
];

export const feedbackCsv = (entries: FeedbackListEntry[]): string => {
  const rows = entries.map((e) => [
    e.eventName,
    e.companyName,
    day(e.eventStartDate),
    day(e.submittedAt),
    day(e.updatedAt),
    e.score,
    e.workedBest,
    e.toImprove,
    e.logoUrl,
    permissionCell(e.permissions.COMPANY_NAME_LOGO),
    permissionCell(e.permissions.QUOTE),
    permissionCell(e.permissions.CASE_STUDY_CONTACT),
    e.photos.selectedCount,
    e.photos.shareableCount,
  ]);
  return '﻿' + [HEADER, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
};
