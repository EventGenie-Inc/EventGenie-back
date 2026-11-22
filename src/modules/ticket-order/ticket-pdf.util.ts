import QRCode from 'qrcode';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { formatGuestDate, formatGuestTime } from '../../shared/utils/guest-date.util.js';

// ─────────────────────────────────────────
//  THE TICKETS PDF (ticket sales Round B)
//
//  One page per ticket, attached to the buyer's confirmation email: the
//  event, each admitted day with its venue or "Online", the ticket type, its
//  QR (only for a ticket that admits a venue day: online-only tickets have
//  none, their link is in the email), its number, the buyer's name and
//  "Ticket 2 of 3". The QR is the same payload the order page shows
//  (EVT1.…). Built in memory, never stored; never logged.
// ─────────────────────────────────────────

export interface PdfTicket {
  number: string;
  typeName: string;
  label: string; // "Ticket 2 of 3"
  payload: string | null;
  days: {
    label: string;
    date: Date;
    startTime: Date | null;
    endTime: Date | null;
    online: boolean;
    location: string | null;
    address: string | null;
  }[];
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

// The standard fonts only draw Latin-1 (WinAnsi): typographic quotes and
// dashes are mapped, anything else outside it becomes "?".
const MAPPED: Record<string, string> = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...' };
export const pdfSafe = (text: string): string =>
  [...text].map((ch) => MAPPED[ch] ?? (ch.charCodeAt(0) <= 0xff ? ch : '?')).join('');

const wrap = (text: string, font: PDFFont, size: number, width: number): string[] => {
  const words = pdfSafe(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= width || !line) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
};

const dayLine = (d: PdfTicket['days'][number]): { when: string; where: string } => {
  const start = d.startTime ? formatGuestTime(d.startTime) : null;
  const end = d.endTime ? formatGuestTime(d.endTime) : null;
  const time = start && end ? `${start} to ${end}` : start;
  return {
    when: `${d.label}: ${formatGuestDate(d.date)}${time ? `, ${time}` : ''}`,
    where: d.online ? 'Online (the link is in your email)' : [d.location, d.address].filter(Boolean).join(', '),
  };
};

export const buildTicketsPdf = async (order: PdfOrder): Promise<Buffer> => {
  const pdf = await PDFDocument.create();
  pdf.setTitle(pdfSafe(`Tickets: ${order.eventName}`));
  pdf.setCreator('e-velope');
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const width = PAGE[0] - MARGIN * 2;

  for (const ticket of order.tickets) {
    const page: PDFPage = pdf.addPage(PAGE);
    let y = PAGE[1] - MARGIN;
    const text = (value: string, opts: { size: number; font?: PDFFont; color?: ReturnType<typeof rgb>; gap?: number }) => {
      for (const line of wrap(value, opts.font ?? regular, opts.size, width)) {
        y -= opts.size + 4;
        page.drawText(line, { x: MARGIN, y, size: opts.size, font: opts.font ?? regular, color: opts.color ?? INK });
      }
      y -= opts.gap ?? 0;
    };

    text(ticket.label.toUpperCase(), { size: 9, font: bold, color: MUTED, gap: 4 });
    text(order.eventName, { size: 18, font: bold, gap: 2 });
    if (order.hostName) text(`Hosted by ${order.hostName}`, { size: 10, color: MUTED, gap: 8 });
    text(ticket.typeName, { size: 13, font: bold, gap: 6 });
    for (const day of ticket.days) {
      const { when, where } = dayLine(day);
      text(when, { size: 10, font: bold });
      if (where) text(where, { size: 10, color: MUTED, gap: 4 });
    }

    y -= 10;
    if (ticket.payload) {
      const png = await QRCode.toBuffer(ticket.payload, { type: 'png', errorCorrectionLevel: 'M', margin: 2, width: 360 });
      const image = await pdf.embedPng(png);
      const size = 190;
      y -= size;
      page.drawImage(image, { x: (PAGE[0] - size) / 2, y, width: size, height: size });
      y -= 6;
      text('Show this code at the door. It admits one person, once on each day above.', { size: 9, color: MUTED, gap: 6 });
    } else {
      text('This ticket is for online days only: join with the link in your email. No code is needed.', { size: 10, color: MUTED, gap: 6 });
    }

    text(`Ticket number: ${ticket.number}`, { size: 11, font: bold });
    text(`Bought by: ${order.buyerName}`, { size: 10, color: MUTED });
    page.drawText(pdfSafe('Sent with e-velope · e-velope.co.za'), { x: MARGIN, y: MARGIN / 2 + 4, size: 8, font: regular, color: MUTED });
  }
  return Buffer.from(await pdf.save());
};
