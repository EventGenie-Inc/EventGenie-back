import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTicketsPdf, type PdfDay, type PdfOrder } from '../../src/modules/ticket-order/ticket-pdf.util.js';
import { pdfPagesOf, type PdfPage, type PdfTextRun } from '../helpers/pdf.js';

// ─────────────────────────────────────────
//  THE TICKETS PDF NEVER OVERFLOWS
//
//  Read from the generated PDF itself (each drawn line's position, size and
//  font, measured with the standard font's metrics; each image's place),
//  never from the layout code: nothing below the footer's top edge (48pt:
//  the logo at 16 to 40pt, 8pt clear above it) or past the right margin, no
//  font under 9pt, the QR at 190pt, centred, decoding, with no text over it,
//  and the logo on every page. Up to 3 days are listed in full; more, or a
//  list that doesn't fit, is compact. Long names and addresses are cut with
//  "…". Dates: 1 Dec 2025 is a Monday.
// ─────────────────────────────────────────

const FOOTER_TOP = 48;
const RIGHT_EDGE = 420 - 32;
const QR = { x: 115, width: 190, height: 190 };

const dec = (n: number): Date => new Date(Date.UTC(2025, 11, n));
const day = (date: Date, over: Partial<PdfDay> = {}): PdfDay => ({
  label: `Day ${date.getUTCDate()}`,
  date,
  startTime: new Date(date.getTime() + 10 * 3600_000),
  endTime: new Date(date.getTime() + 17 * 3600_000),
  online: false,
  location: 'Test Hall',
  address: '1 Example Road, Testville',
  ...over,
});
const online = (date: Date): PdfDay => day(date, { online: true, location: null, address: null });
const decDays = (...ns: number[]) => ns.map((n) => day(dec(n)));

const orderOf = (days: PdfDay[], over: Partial<PdfOrder> = {}, ticket: { typeName?: string; payload?: string | null } = {}): PdfOrder => ({
  eventName: 'Sample Test Festival',
  hostName: 'Test Host Co',
  buyerName: 'Thandi Testbuyer',
  tickets: [1, 2].map((i) => ({
    number: `TK-TEST-000${i}`,
    typeName: ticket.typeName ?? 'General',
    label: `Ticket ${i} of 2`,
    payload: ticket.payload === undefined ? `EVT1.sample-ticket-${i}.not-a-signature` : ticket.payload,
    days,
  })),
  ...over,
});

const LONG_NAME = 'The Annual Southern Hemisphere Celebration of Music, Food, Art and Community 202'; // 80
const LONG_ADDRESS =
  'Unit 12, The Very Long Business Park Building, 1234 Extraordinarily Lengthy Avenue Extension, Industrial Area North, Testville Central, Province 00012'; // 150

const isLogo = (i: PdfPage['images'][number]) => i.pixelWidth === 400 && i.pixelHeight === 90;
const joined = (page: PdfPage) => page.runs.map((r) => r.text).join('\n');
const runsAt = (page: PdfPage, size: number, font: PdfTextRun['font']) => page.runs.filter((r) => r.size === size && r.font === font);

// Every page of the PDF: fits above the footer, QR and logo as they should be.
const pagesFitting = async (order: PdfOrder): Promise<PdfPage[]> => {
  const pages = await pdfPagesOf(await buildTicketsPdf(order));
  expect(pages).toHaveLength(order.tickets.length);
  pages.forEach((page, i) => {
    for (const run of page.runs) {
      expect(run.bottom, `"${run.text}" reaches below the footer`).toBeGreaterThanOrEqual(FOOTER_TOP);
      expect(run.right, `"${run.text}" runs past the right margin`).toBeLessThanOrEqual(RIGHT_EDGE + 0.001);
      expect(run.size).toBeGreaterThanOrEqual(9);
    }
    const logos = page.images.filter(isLogo);
    expect(logos).toHaveLength(1);
    expect(logos[0]!.y + logos[0]!.height).toBeLessThanOrEqual(FOOTER_TOP);
    const qrs = page.images.filter((img) => !isLogo(img));
    const payload = order.tickets[i]!.payload;
    if (payload) {
      expect(qrs).toHaveLength(1);
      const qr = qrs[0]!;
      expect({ x: qr.x, width: qr.width, height: qr.height }).toEqual(QR);
      expect(qr.y).toBeGreaterThanOrEqual(FOOTER_TOP);
      expect(qr.qr).toBe(payload);
      for (const run of page.runs) {
        expect(run.bottom >= qr.y + qr.height || run.top <= qr.y, `"${run.text}" overlaps the QR`).toBe(true);
      }
    } else {
      expect(qrs).toHaveLength(0);
    }
  });
  return pages;
};

afterEach(() => vi.restoreAllMocks());

describe('the tickets PDF fits its page', () => {
  describe('up to 3 days: each listed in full, the QR where it always was', () => {
    it('1 day', async () => {
      for (const page of await pagesFitting(orderOf(decDays(1)))) {
        expect(page.text).toContain('Day 1: 1 December 2025, 10:00 to 17:00');
        expect(page.text).toContain('Test Hall, 1 Example Road, Testville');
        expect(page.images.find((i) => !isLogo(i))!.y).toBe(245);
      }
    });

    it('3 days', async () => {
      for (const page of await pagesFitting(orderOf(decDays(1, 2, 3)))) {
        for (const n of [1, 2, 3]) expect(page.text).toContain(`Day ${n}: ${n} December 2025, 10:00 to 17:00`);
        expect(page.text.filter((t) => t === 'Test Hall, 1 Example Road, Testville')).toHaveLength(3);
        expect(page.images.find((i) => !isLogo(i))!.y).toBe(181);
      }
    });

    it('a venue day and an online day', async () => {
      for (const page of await pagesFitting(orderOf([day(dec(1)), online(dec(2))]))) {
        expect(page.text).toContain('Day 1: 1 December 2025, 10:00 to 17:00');
        expect(page.text).toContain('Day 2: 2 December 2025, 10:00 to 17:00');
        expect(page.text).toContain('Online (the link is in your email)');
      }
    });

    it("3 days that don't fit in full (long labels, long addresses, a 2-line name) are compact", async () => {
      const days = [1, 2, 3].map((n) =>
        day(dec(n), { label: `Day ${n}: an unusually long label for this day of the programme, with more detail`, address: LONG_ADDRESS })
      );
      for (const page of await pagesFitting(orderOf(days, { eventName: LONG_NAME }))) {
        expect(page.text).toContain('3 days: Mon 1 – Wed 3 Dec');
        expect(page.text.some((t) => t.startsWith('Day 1'))).toBe(false);
      }
    });
  });

  describe('more than 3 days: compact', () => {
    it('5 consecutive days at one venue: a range, the venue once', async () => {
      for (const page of await pagesFitting(orderOf(decDays(1, 2, 3, 4, 5)))) {
        expect(page.text).toContain('5 days: Mon 1 – Fri 5 Dec');
        expect(page.text.filter((t) => t === 'Test Hall, 1 Example Road, Testville')).toHaveLength(1);
      }
    });

    it('10 consecutive days at one venue', async () => {
      for (const page of await pagesFitting(orderOf(decDays(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)))) {
        expect(page.text).toContain('10 days: Mon 1 – Wed 10 Dec');
        expect(page.text.filter((t) => t === 'Test Hall, 1 Example Road, Testville')).toHaveLength(1);
      }
    });

    it('consecutive days across a month boundary', async () => {
      const days = [29, 30, 31].map((n) => day(dec(n))).concat([1, 2].map((n) => day(new Date(Date.UTC(2026, 0, n)))));
      for (const page of await pagesFitting(orderOf(days))) expect(page.text).toContain('5 days: Mon 29 Dec – Fri 2 Jan');
    });

    it('non-consecutive days: a list, each month named once', async () => {
      for (const page of await pagesFitting(orderOf(decDays(1, 3, 5, 8, 10)))) {
        expect(page.text).toContain('Mon 1, Wed 3, Fri 5, Mon 8, Wed 10 Dec');
      }
      const across = [26, 29, 31].map((n) => day(dec(n))).concat([2, 5].map((n) => day(new Date(Date.UTC(2026, 0, n)))));
      for (const page of await pagesFitting(orderOf(across))) expect(page.text).toContain('Fri 26, Mon 29, Wed 31 Dec, Fri 2, Mon 5 Jan');
    });

    it('5 non-consecutive days at different venues: a pointer to the email and order page', async () => {
      const days = [1, 3, 5, 8, 10].map((n) => day(dec(n), { location: `Hall ${n}`, address: `${n} Example Road, Testville` }));
      for (const page of await pagesFitting(orderOf(days))) {
        expect(joined(page).replace(/\n/g, ' ')).toContain('Venue details for each day are in your confirmation email and on your order page.');
        expect(joined(page)).not.toContain('Hall 3');
      }
    });

    it('venue days with online days: the venue days, "Plus online sessions"', async () => {
      const days = [...decDays(1, 2, 3, 4), online(dec(5)), online(dec(6))];
      for (const page of await pagesFitting(orderOf(days))) {
        expect(page.text).toContain('4 days: Mon 1 – Thu 4 Dec');
        expect(page.text).toContain('Test Hall, 1 Example Road, Testville');
        expect(page.text).toContain('Plus online sessions: the links are in your email.');
        expect(joined(page)).not.toContain('Online (the link');
      }
    });

    it('online days only: no QR, the dates, where the links are', async () => {
      const days = [1, 2, 3, 4].map((n) => online(dec(n)));
      for (const page of await pagesFitting(orderOf(days, {}, { payload: null }))) {
        expect(page.text).toContain('4 days: Mon 1 – Thu 4 Dec');
        expect(page.text).toContain('Online: the links are in your email.');
      }
    });
  });

  describe('long text is cut, never shrunk', () => {
    it('an 80-character event name: 2 lines at 18pt, ending "…"', async () => {
      expect(LONG_NAME).toHaveLength(80);
      for (const page of await pagesFitting(orderOf(decDays(1, 2), { eventName: LONG_NAME }))) {
        const name = runsAt(page, 18, 'Helvetica-Bold');
        expect(name).toHaveLength(2);
        expect(name[0]!.text.startsWith('The Annual')).toBe(true);
        expect(name[1]!.text.endsWith('…')).toBe(true);
        // Cut at a word's end, not inside one.
        const lastWord = name[1]!.text.slice(0, -1).split(' ').pop()!;
        expect(LONG_NAME.split(/[\s,]+/)).toContain(lastWord);
      }
    });

    it('a 150-character address: 2 lines, ending "…"', async () => {
      expect(LONG_ADDRESS).toHaveLength(150);
      for (const page of await pagesFitting(orderOf([day(dec(1), { address: LONG_ADDRESS })]))) {
        const first = page.runs.findIndex((r) => r.text.startsWith('Test Hall, Unit 12'));
        expect(first).toBeGreaterThan(-1);
        expect(page.runs[first + 1]!.text.endsWith('…')).toBe(true);
        expect(page.runs[first + 2]!.text.startsWith('Show this code')).toBe(true);
      }
    });

    it('everything long at once: 20 scattered days over two months at different venues, online days, long type, host and buyer', async () => {
      const days = [
        ...[1, 3, 5, 8, 10, 12, 15, 17, 19, 22, 24, 26, 29, 31].map((n) => day(dec(n), { location: `Hall ${n}`, address: LONG_ADDRESS })),
        ...[2, 5, 7, 9, 12, 14].map((n) => day(new Date(Date.UTC(2026, 0, n)), { address: LONG_ADDRESS })),
        online(dec(2)),
        online(dec(4)),
      ];
      const order = orderOf(
        days,
        { eventName: LONG_NAME, hostName: `A Host Whose Name Is Far Too Long To Fit On One Line Of The Ticket At All`, buyerName: 'Thandiwe Nomvula Testbuyer-Longsurname of the Very Long Family Name Indeed' },
        { typeName: 'Premium Weekend and Weekday All-Access Pass with Backstage Entry and Parking' }
      );
      for (const page of await pagesFitting(order)) {
        expect(runsAt(page, 18, 'Helvetica-Bold')).toHaveLength(2);
        expect(runsAt(page, 13, 'Helvetica-Bold')).toHaveLength(1);
        expect(runsAt(page, 13, 'Helvetica-Bold')[0]!.text.endsWith('…')).toBe(true);
        expect(page.text.find((t) => t.startsWith('Hosted by'))!.endsWith('…')).toBe(true);
        expect(page.text.find((t) => t.startsWith('Bought by'))!.endsWith('…')).toBe(true);
        expect(page.text).toContain('Plus online sessions: the links are in your email.');
      }
    });
  });
});
