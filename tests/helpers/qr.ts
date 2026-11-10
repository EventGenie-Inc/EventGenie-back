import { PNG } from 'pngjs';
import jsQRModule, { type QRCode } from 'jsqr';
import { type InlineImage } from '../../src/shared/messaging/email.engine.js';

// ─────────────────────────────────────────
//  QR CODES IN TESTS
//
//  decodeQrPng reads a PNG the way a phone camera reads the screen: pixels
//  in, text out (jsQR), so a test proves what a code actually opens, not
//  just that an image is there. STAND_IN_QR is for builder tests that need
//  an InviteEmailInput but aren't about the code itself.
// ─────────────────────────────────────────

// jsqr is CommonJS with an ES-style default. Under Node's ESM the default
// import is the function itself, but its types resolve to the module, so
// they are restated here.
const jsQR = jsQRModule as unknown as (data: Uint8ClampedArray, width: number, height: number) => QRCode | null;

export const decodeQrPng = (png: Buffer): string | null => {
  const image = PNG.sync.read(png);
  return jsQR(new Uint8ClampedArray(image.data), image.width, image.height)?.data ?? null;
};

export const decodeQrDataUrl = (dataUrl: string): string | null => {
  const prefix = 'data:image/png;base64,';
  if (!dataUrl.startsWith(prefix)) throw new Error(`not a PNG data URL: ${dataUrl.slice(0, 40)}`);
  return decodeQrPng(Buffer.from(dataUrl.slice(prefix.length), 'base64'));
};

export const STAND_IN_QR: InlineImage = {
  contentId: 'invite-qr',
  filename: 'e-velope-qr.png',
  contentType: 'image/png',
  content: Buffer.from('not a real png'),
};

// What Resend was handed for one email (tests/setup.ts's mock receives the
// SDK payload): its inline images, with their base64 content decoded.
export interface SentAttachment {
  content: string;
  filename: string;
  contentType: string;
  contentId: string;
}

export const inlineQrOf = (email: { attachments?: SentAttachment[] }): { attachment: SentAttachment; decoded: string | null } | null => {
  const attachment = email.attachments?.find((a) => a.contentId === 'invite-qr');
  return attachment ? { attachment, decoded: decodeQrPng(Buffer.from(attachment.content, 'base64')) } : null;
};
