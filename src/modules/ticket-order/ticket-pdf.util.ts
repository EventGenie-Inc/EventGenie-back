import { readFileSync } from 'fs';
import { resolve } from 'path';
import QRCode from 'qrcode';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from 'pdf-lib';
import { formatGuestDate, formatGuestTime } from '../../shared/utils/guest-date.util.js';

// ─────────────────────────────────────────
//  THE TICKETS PDF (ticket sales Round B)
//
//  One page per ticket, attached to the buyer's confirmation email: the
//  event, each admitted day with its venue or "Online", the ticket type, its
//  QR (only for a ticket that admits a venue day: online-only tickets have
//  none, their link is in the email), its number, the buyer's name and
//  "Ticket 2 of 3". The QR is the same payload the order page shows
//  (EVT1.…). Built in memory, never stored; never logged. Each page ends with
//  the e-velope logo (see "The logo" below).
//
//  A page never overflows (see "Fitting the page"): every block is measured
//  before anything is drawn, long text is cut to a set number of lines, and
//  more than 3 days (or a list that doesn't fit) is shown compactly. Nothing
//  is drawn below the footer's top edge.
// ─────────────────────────────────────────

export interface PdfTicket {
  number: string;
  typeName: string;
  label: string; // "Ticket 2 of 3"
  payload: string | null;
  days: PdfDay[];
}

export interface PdfDay {
  label: string;
  date: Date;
  startTime: Date | null;
  endTime: Date | null;
  online: boolean;
  location: string | null;
  address: string | null;
}

export interface PdfOrder {
  eventName: string;
  hostName: string | null;
  buyerName: string;
  tickets: PdfTicket[];
}

const PAGE: [number, number] = [420, 595]; // A5, portrait
const MARGIN = 32;
const INK = rgb(0.13, 0.13, 0.16);
const MUTED = rgb(0.42, 0.42, 0.47);
const QR_SIZE = 190;
const LINE_GAP = 4; // added to the font size for each line's advance
const ELLIPSIS = '…'; // WinAnsi has it: the standard fonts draw it

// The standard fonts only draw Latin-1 (WinAnsi): typographic quotes and
// dashes are mapped, anything else outside it becomes "?". Applied to what
// the organiser and buyer typed (safeOrder); this file's own wording uses
// WinAnsi's "–" and "…" directly.
const MAPPED: Record<string, string> = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...' };
export const pdfSafe = (text: string): string =>
  [...text].map((ch) => MAPPED[ch] ?? (ch.charCodeAt(0) <= 0xff ? ch : '?')).join('');

// Words to lines no wider than `width`; a word wider than a whole line is
// broken by characters, so nothing runs off the page's side.
const wrap = (text: string, font: PDFFont, size: number, width: number): string[] => {
  const fits = (s: string) => font.widthOfTextAtSize(s, size) <= width;
  const words = text.split(/\s+/).filter(Boolean).flatMap((word) => {
    if (fits(word)) return [word];
    const pieces: string[] = [];
    let piece = '';
    for (const ch of word) {
      if (piece && !fits(piece + ch)) {
        pieces.push(piece);
        piece = '';
      }
      piece += ch;
    }
    return piece ? [...pieces, piece] : pieces;
  });
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (fits(next) || !line) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
};

// Wrapped, then cut to `maxLines`, the last ending with "…" when cut: at a
// word's end where one fits, by characters only when a single word doesn't.
const clamp = (text: string, font: PDFFont, size: number, width: number, maxLines: number): string[] => {
  const lines = wrap(text, font, size, width);
  if (lines.length <= maxLines) return lines;
  const fits = (s: string) => font.widthOfTextAtSize(s + ELLIPSIS, size) <= width;
  const words = lines[maxLines - 1]!.split(' ');
  while (words.length > 1 && !fits(words.join(' '))) words.pop();
  let last = words.join(' ').replace(/[\s,;:.–-]+$/, '');
  while (last && !fits(last)) last = last.slice(0, -1);
  return [...lines.slice(0, maxLines - 1), last + ELLIPSIS];
};

// ── The logo ──
// The email lockup PNG (400x90, a byte copy of the frontend's
// public/brand/e-velope-logo-email.png), read from disk once per process and
// embedded once per document, drawn on every page. Resolved from the project
// root, not this file: the built server runs from dist/, and the file is not
// copied there. Never fetched over the network. If it can't be read or
// embedded the page gets the word "e-velope" instead: a ticket is never lost
// over a logo.
export const TICKET_PDF_LOGO_PATH = resolve(process.cwd(), 'assets', 'brand', 'e-velope-logo-email.png');
const LOGO_HEIGHT = 24; // pt; the width keeps the PNG's proportions (~107pt, ~270 ppi)
const LOGO_Y = MARGIN / 2;
// The footer: the band at the bottom of the page holding the logo (16 to 40pt)
// and 8pt clear above it. Nothing else is ever drawn below its top edge.
export const FOOTER_TOP = LOGO_Y + LOGO_HEIGHT + 8;

let logoPath = TICKET_PDF_LOGO_PATH;
// undefined: not read yet; null: unusable (already logged).
let logoBytes: Buffer | null | undefined;

const logoFile = (): Buffer | null => {
  if (logoBytes === undefined) {
    try {
      logoBytes = readFileSync(logoPath);
    } catch (err) {
      console.error('[ticket-pdf] logo not read, using text instead:', err instanceof Error ? err.message : err);
      logoBytes = null;
    }
  }
  return logoBytes;
};

const embedLogo = async (pdf: PDFDocument): Promise<PDFImage | null> => {
  const bytes = logoFile();
  if (!bytes) return null;
  try {
    return await pdf.embedPng(bytes);
  } catch (err) {
    console.error('[ticket-pdf] logo not embedded, using text instead:', err instanceof Error ? err.message : err);
    logoBytes = null; // the same bytes would fail every time
    return null;
  }
};

/** Tests only: read the logo from another path on the next PDF (none: the real one). */
export const setTicketPdfLogoPathForTests = (path?: string): void => {
  logoPath = path ?? TICKET_PDF_LOGO_PATH;
  logoBytes = undefined;
};

// ── Days ──
// Up to 3 days, each is listed in full: its label, date and time, then its
// venue or "Online". More than 3, or a full list that doesn't fit, is
// compact: the venue days' dates in one line ("5 days: Mon 1 – Fri 5 Dec",
// or "Mon 1, Wed 3, Fri 5 Dec" when they aren't consecutive), the venue once
// if every venue day shares it (otherwise a pointer to the email and order
// page, which list each day's venue), and "Plus online sessions" for online
// days. Dates are calendar dates, read in UTC (guest-date.util.ts).
const FULL_DAYS_MAX = 3;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

const whenOf = (d: PdfDay): string => {
  const start = d.startTime ? formatGuestTime(d.startTime) : null;
  const end = d.endTime ? formatGuestTime(d.endTime) : null;
  const time = start && end ? `${start} to ${end}` : start;
  return `${d.label}: ${formatGuestDate(d.date)}${time ? `, ${time}` : ''}`;
};

const venueOf = (d: PdfDay): string => [d.location, d.address].filter(Boolean).join(', ');

const dayStart = (date: Date): number => Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
const weekdayDay = (t: number): string => `${WEEKDAYS[new Date(t).getUTCDay()]} ${new Date(t).getUTCDate()}`;
const monthOf = (t: number): string => MONTHS[new Date(t).getUTCMonth()]!;

// The distinct calendar dates, earliest first, in the compact forms.
const compactDates = (days: PdfDay[]): { list: string; range: string | null; span: string } => {
  const dates = [...new Set(days.map((d) => dayStart(d.date)))].sort((a, b) => a - b);
  const first = dates[0]!;
  const last = dates[dates.length - 1]!;
  const sameMonth = monthOf(first) === monthOf(last) && last - first < 31 * DAY_MS;
  const fromTo = `${weekdayDay(first)}${sameMonth ? '' : ` ${monthOf(first)}`} – ${weekdayDay(last)} ${monthOf(last)}`;
  const consecutive = dates.length > 1 && dates.every((t, i) => i === 0 || t - dates[i - 1]! === DAY_MS);
  // "Mon 29, Wed 31 Dec, Fri 2 Jan": each month named after its last date.
  const list = dates
    .map((t, i) => (i === dates.length - 1 || monthOf(dates[i + 1]!) !== monthOf(t) ? `${weekdayDay(t)} ${monthOf(t)}` : weekdayDay(t)))
    .join(', ');
  return {
    list,
    range: consecutive ? `${dates.length} days: ${fromTo}` : null,
    // The last resort when even the list is too long: one line, always.
    span: dates.length === 1 ? list : `${dates.length} days from ${fromTo}`,
  };
};

// ── Fitting the page ──
// A page is a list of blocks, measured before anything is drawn: lines of
// text (each advancing its font size plus 4pt) or the QR. The QR keeps its
// size (190pt) and place (centred, just below the details), as it always had.
interface TextLine {
  text: string;
  font: PDFFont;
  size: number;
  color: RGB;
}
type Block = { kind: 'text'; lines: TextLine[]; gap: number } | { kind: 'space'; height: number } | { kind: 'qr'; payload: string };

const descentOf = (line: TextLine): number => line.font.heightAtSize(line.size) - line.font.heightAtSize(line.size, { descender: false });

const TOP = PAGE[1] - MARGIN;

// The lowest point the blocks reach, walked exactly as they are drawn: a
// line's baseline less its font's descender (the lowest ink of its text),
// the QR's bottom edge.
const lowestPoint = (blocks: Block[]): number => {
  let y = TOP;
  let lowest = TOP;
  for (const b of blocks) {
    if (b.kind === 'space') y -= b.height;
    else if (b.kind === 'qr') lowest = Math.min(lowest, (y -= QR_SIZE));
    else {
      for (const line of b.lines) lowest = Math.min(lowest, (y -= line.size + LINE_GAP) - descentOf(line));
      y -= b.gap;
    }
  }
  return lowest;
};

const CONTENT_WIDTH = PAGE[0] - MARGIN * 2;

type DaysMode = 'full' | 'compact' | 'span';

const pageBlocks = (order: PdfOrder, ticket: PdfTicket, fonts: { regular: PDFFont; bold: PDFFont }, mode: DaysMode): Block[] => {
  const { regular, bold } = fonts;
  const lines = (text: string, size: number, font: PDFFont, color: RGB, maxLines: number): TextLine[] =>
    clamp(text, font, size, CONTENT_WIDTH, maxLines).map((t) => ({ text: t, font, size, color }));
  const text = (ls: TextLine[], gap = 0): Block => ({ kind: 'text', lines: ls, gap });

  const blocks: Block[] = [
    text(lines(ticket.label.toUpperCase(), 9, bold, MUTED, 1), 4),
    text(lines(order.eventName, 18, bold, INK, 2), 2),
  ];
  if (order.hostName) blocks.push(text(lines(`Hosted by ${order.hostName}`, 10, regular, MUTED, 1), 8));
  blocks.push(text(lines(ticket.typeName, 13, bold, INK, 1), 6));

  const days = [...ticket.days].sort((a, b) => a.date.getTime() - b.date.getTime());
  if (mode === 'full') {
    for (const day of days) {
      blocks.push(text(lines(whenOf(day), 10, bold, INK, 2)));
      blocks.push(text(lines(day.online ? 'Online (the link is in your email)' : venueOf(day), 10, regular, MUTED, 2), 4));
    }
  } else if (days.length > 0) {
    const venueDays = days.filter((d) => !d.online);
    const dated = venueDays.length ? venueDays : days;
    const forms = compactDates(dated);
    const datesLines =
      mode === 'span'
        ? lines(forms.span, 10, bold, INK, 1)
        : forms.range
          ? lines(forms.range, 10, bold, INK, 1)
          : wrap(forms.list, bold, 10, CONTENT_WIDTH).length <= 3
            ? lines(forms.list, 10, bold, INK, 3)
            : lines(forms.span, 10, bold, INK, 1);
    blocks.push(text(datesLines));
    if (venueDays.length) {
      const venues = new Set(venueDays.map(venueOf));
      const venue = venues.size === 1
        ? [...venues][0]!
        : 'Venue details for each day are in your confirmation email and on your order page.';
      if (venue) blocks.push(text(lines(venue, 10, regular, MUTED, 2)));
      if (venueDays.length < days.length) blocks.push(text(lines('Plus online sessions: the links are in your email.', 10, regular, MUTED, 2)));
    } else {
      blocks.push(text(lines('Online: the links are in your email.', 10, regular, MUTED, 1)));
    }
    (blocks[blocks.length - 1] as Extract<Block, { kind: 'text' }>).gap = 4;
  }

  blocks.push({ kind: 'space', height: 10 });
  if (ticket.payload) {
    blocks.push({ kind: 'qr', payload: ticket.payload });
    blocks.push({ kind: 'space', height: 6 });
    blocks.push(text(lines('Show this code at the door. It admits one person, once on each day above.', 9, regular, MUTED, 2), 6));
  } else {
    blocks.push(text(lines('This ticket is for online days only: join with the link in your email. No code is needed.', 10, regular, MUTED, 2), 6));
  }
  blocks.push(text(lines(`Ticket number: ${ticket.number}`, 11, bold, INK, 1)));
  blocks.push(text(lines(`Bought by: ${order.buyerName}`, 10, regular, MUTED, 1)));
  return blocks;
};

// The fullest layout that fits: every day in full (up to 3), then compact,
// then the one-line span. Every block is capped in lines, so the span
// layout's depth has a fixed ceiling well inside the page (about 450 of the
// 515pt); the guard below only logs if that ever stops being true.
const layoutFor = (order: PdfOrder, ticket: PdfTicket, fonts: { regular: PDFFont; bold: PDFFont }): Block[] => {
  const modes: DaysMode[] = ticket.days.length <= FULL_DAYS_MAX ? ['full', 'compact', 'span'] : ['compact', 'span'];
  for (const mode of modes) {
    const blocks = pageBlocks(order, ticket, fonts, mode);
    if (lowestPoint(blocks) >= FOOTER_TOP) return blocks;
  }
  console.error('[ticket-pdf] a ticket page is taller than the space above the footer; lines below it are left out');
  return pageBlocks(order, ticket, fonts, 'span');
};

const safeText = (s: string | null): string | null => (s === null ? null : pdfSafe(s));
const safeOrder = (order: PdfOrder): PdfOrder => ({
  eventName: pdfSafe(order.eventName),
  hostName: safeText(order.hostName),
  buyerName: pdfSafe(order.buyerName),
  tickets: order.tickets.map((t) => ({
    ...t,
    number: pdfSafe(t.number),
    typeName: pdfSafe(t.typeName),
    label: pdfSafe(t.label),
    days: t.days.map((d) => ({ ...d, label: pdfSafe(d.label), location: safeText(d.location), address: safeText(d.address) })),
  })),
});

export const buildTicketsPdf = async (input: PdfOrder): Promise<Buffer> => {
  const order = safeOrder(input);
  const pdf = await PDFDocument.create();
  pdf.setTitle(pdfSafe(`Tickets: ${order.eventName}`));
  pdf.setCreator('e-velope');
  const fonts = { regular: await pdf.embedFont(StandardFonts.Helvetica), bold: await pdf.embedFont(StandardFonts.HelveticaBold) };
  const logo = await embedLogo(pdf);

  for (const ticket of order.tickets) {
    const page: PDFPage = pdf.addPage(PAGE);
    let y = TOP;
    for (const block of layoutFor(order, ticket, fonts)) {
      if (block.kind === 'space') y -= block.height;
      else if (block.kind === 'qr') {
        const png = await QRCode.toBuffer(block.payload, { type: 'png', errorCorrectionLevel: 'M', margin: 2, width: 360 });
        y -= QR_SIZE;
        page.drawImage(await pdf.embedPng(png), { x: (PAGE[0] - QR_SIZE) / 2, y, width: QR_SIZE, height: QR_SIZE });
      } else {
        for (const line of block.lines) {
          y -= line.size + LINE_GAP;
          // Never below the footer, whatever the measuring said.
          if (y - descentOf(line) < FOOTER_TOP) continue;
          page.drawText(line.text, { x: MARGIN, y, size: line.size, font: line.font, color: line.color });
        }
        y -= block.gap;
      }
    }
    if (logo) {
      page.drawImage(logo, { x: MARGIN, y: LOGO_Y, width: (logo.width / logo.height) * LOGO_HEIGHT, height: LOGO_HEIGHT });
    } else {
      page.drawText('e-velope', { x: MARGIN, y: LOGO_Y + 8, size: 10, font: fonts.bold, color: MUTED });
    }
  }
  return Buffer.from(await pdf.save());
};
