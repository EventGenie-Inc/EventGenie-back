import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildTicketsPdf, setTicketPdfLogoPathForTests, type PdfOrder } from '../../src/modules/ticket-order/ticket-pdf.util.js';
import { pdfImageObjectsOf, pdfPagesOf, type PdfPageImage } from '../helpers/pdf.js';

// ─────────────────────────────────────────
//  THE TICKETS PDF: THE LOGO
//
//  Every page ends with the e-velope logo (the email lockup PNG, 400x90,
//  from assets/brand/), embedded once per document and drawn 24pt tall in
//  proportion where "Sent with e-velope" used to be. The QR is unchanged and
//  still decodes. Without the file (missing, or not a PNG) the PDF is still
//  made, with "e-velope" as text, and the failure is logged without the
//  buyer's details. No database: the builder alone.
// ─────────────────────────────────────────

const day = (label: string, online = false) => ({
  label,
  date: new Date('2027-03-06T00:00:00Z'),
  startTime: new Date('2027-03-06T08:00:00Z'),
  endTime: new Date('2027-03-06T15:00:00Z'),
  online,
  location: online ? null : 'Test Hall',
  address: online ? null : '1 Example Road, Testville',
});

const order: PdfOrder = {
  eventName: 'Sample Test Festival',
  hostName: 'Test Host Co',
  buyerName: 'Thandi Testbuyer',
  tickets: [
    { number: 'TK-AAAA-2222', typeName: 'General', label: 'Ticket 1 of 3', payload: 'EVT1.ticket-one.sig-one', days: [day('Day 1'), day('Day 2')] },
    { number: 'TK-BBBB-3333', typeName: 'General', label: 'Ticket 2 of 3', payload: 'EVT1.ticket-two.sig-two', days: [day('Day 1'), day('Day 2')] },
    { number: 'TK-CCCC-4444', typeName: 'Saturday', label: 'Ticket 3 of 3', payload: 'EVT1.ticket-three.sig-three', days: [day('Day 2')] },
  ],
};

const isLogo = (i: PdfPageImage) => i.pixelWidth === 400 && i.pixelHeight === 90;
const QR_SIZE = 190;
const QR_X = (420 - QR_SIZE) / 2; // centred on the A5 page, as before the logo

afterEach(() => {
  setTicketPdfLogoPathForTests();
  vi.restoreAllMocks();
});

describe('the logo on the tickets PDF', () => {
  it('is on every page: one embedded image, drawn where the footer text was, 24pt tall in proportion', async () => {
    const bytes = await buildTicketsPdf(order);
    const pages = await pdfPagesOf(bytes);
    expect(pages).toHaveLength(3);

    for (const page of pages) {
      const logos = page.images.filter(isLogo);
      expect(logos).toHaveLength(1);
      const logo = logos[0]!;
      expect(logo.height).toBe(24);
      expect(logo.width).toBeCloseTo((400 / 90) * 24, 3);
      expect({ x: logo.x, y: logo.y }).toEqual({ x: 32, y: 16 });
      expect(page.text.join(' ')).not.toContain('Sent with');
    }
    // Embedded once per document: the same object on every page, and one in the file.
    expect(new Set(pages.map((p) => p.images.find(isLogo)!.ref)).size).toBe(1);
    expect((await pdfImageObjectsOf(bytes)).filter((i) => i.pixelWidth === 400 && i.pixelHeight === 90)).toHaveLength(1);
  });

  it("leaves the QR as it was: each page's code decodes to its ticket's payload, at the same size and place", async () => {
    const pages = await pdfPagesOf(await buildTicketsPdf(order));
    setTicketPdfLogoPathForTests(join(tmpdir(), 'no-such-dir', 'missing-logo.png'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const withoutLogo = await pdfPagesOf(await buildTicketsPdf(order));

    pages.forEach((page, i) => {
      const qrs = page.images.filter((img) => !isLogo(img));
      expect(qrs).toHaveLength(1);
      expect(qrs[0]!.qr).toBe(order.tickets[i]!.payload);
      expect({ x: qrs[0]!.x, width: qrs[0]!.width, height: qrs[0]!.height }).toEqual({ x: QR_X, width: QR_SIZE, height: QR_SIZE });
      expect(qrs[0]!.y).toBe(withoutLogo[i]!.images[0]!.y);
    });
  });

  describe('without the logo file, the PDF is still made with "e-velope" as text', () => {
    const fallsBack = async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const pages = await pdfPagesOf(await buildTicketsPdf(order));
      expect(pages).toHaveLength(3);
      pages.forEach((page, i) => {
        expect(page.images.filter(isLogo)).toHaveLength(0);
        expect(page.text).toContain('e-velope');
        expect(page.images.map((img) => img.qr)).toEqual([order.tickets[i]!.payload]);
      });
      // Logged once, and without the buyer's details or the tickets.
      expect(errors).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(errors.mock.calls);
      expect(logged).toContain('[ticket-pdf] logo');
      for (const secret of [order.buyerName, order.eventName, ...order.tickets.flatMap((t) => [t.number, t.payload!])]) {
        expect(logged).not.toContain(secret);
      }
      // A second PDF doesn't try again or log again.
      const again = await pdfPagesOf(await buildTicketsPdf(order));
      expect(again[0]!.text).toContain('e-velope');
      expect(errors).toHaveBeenCalledTimes(1);
    };

    it('a missing file', async () => {
      setTicketPdfLogoPathForTests(join(tmpdir(), 'no-such-dir', 'missing-logo.png'));
      await fallsBack();
    });

    it('a file that is not a PNG', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ticket-pdf-logo-'));
      try {
        const path = join(dir, 'e-velope-logo-email.png');
        writeFileSync(path, 'not a png at all');
        setTicketPdfLogoPathForTests(path);
        await fallsBack();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
