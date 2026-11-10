import QRCode from 'qrcode';

// ─────────────────────────────────────────
//  QR CODES, AS PNG
//
//  Generated here, on the server, never by a third-party image service: what
//  a QR code carries is usually a credential (a guest's invitation link), and
//  it must not travel in an image address.
//
//  Black on white with the standard 4-module quiet zone baked into the
//  image, so it scans even where a dark theme paints the background around
//  it. Error correction M (15%), enough for a screen photographed at an
//  angle, while keeping an invitation link (~100 characters) at version 6.
//  QR_PNG_WIDTH pixels square: shown at QR_DISPLAY_WIDTH, it is sharp on a
//  2x screen.
// ─────────────────────────────────────────

export const QR_PNG_WIDTH = 320;
export const QR_DISPLAY_WIDTH = 160;

export const qrCodePng = (text: string): Promise<Buffer> =>
  QRCode.toBuffer(text, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 4,
    width: QR_PNG_WIDTH,
    color: { dark: '#000000', light: '#ffffff' },
  });
