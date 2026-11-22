import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireFeature } from '../../shared/middleware/feature.middleware.js';
import { rsvpService } from './rsvp.service.js';
import { ticketPurchaseRetired } from '../ticket-purchase/ticket-purchase-retired.util.js';
import { eventProgramService } from '../event-program/event-program.service.js';
import {
  rsvpProgramLimiter,
  rsvpProgramIpLimiter,
  rsvpQrLimiter,
  rsvpQrIpLimiter,
  rsvpPassesLimiter,
  rsvpPassesIpLimiter,
  rsvpSubmitInviteLimiter,
  shortLinkIpLimiter,
  shortLinkLimiter,
  documentUploadInviteLimiter,
  documentUploadIpLimiter,
} from '../../shared/middleware/rate-limit.middleware.js';
import { guestDocumentService } from '../guest-document/guest-document.service.js';
import { receiveDocument } from '../guest-document/guest-document.router.js';
import { checkInPassService } from '../check-in-pass/check-in-pass.service.js';

// Fully public surface — a guest only has a bare invite token, never a
// platform session. No auth middleware anywhere in this file.
const router = Router();

// GET /api/rsvp/validate/:token
router.get('/validate/:token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await rsvpService.validate(req.params['token'] as string);
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

// POST rather than a query string: the invite token is the guest's
// credential and must not be placed in URLs, logs, or referrers.
//
// RETIRED (ticket sales Round B): tickets are sold for public events only,
// through /api/ticket-orders. 410 TICKET_PURCHASE_RETIRED, whatever the body.
router.post('/ticket-quote', (_req: Request, _res: Response, next: NextFunction) => next(ticketPurchaseRetired()));

// POST /api/rsvp/program
// { token } — Contract A. Tells the guest's page whether to show a
// Program tab and, if so, this invite's days with the items scheduled
// on each (day-scoped items plus every item with no day set). Its own
// two limiters, not shared with any other budget: per invite, and the
// per-IP failures backstop in front (rate-limit.middleware.ts). See
// event-program.service.ts's getProgramForInvite.
router.post('/program', rsvpProgramIpLimiter, rsvpProgramLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await eventProgramService.getProgramForInvite(req.body?.token);
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

// POST /api/rsvp/qr
// { token } → { url, image (a PNG data URL), width, height }: the QR code
// of this guest's own invitation link, for the page's "Continue on your
// phone" (rsvp.service.ts's getInviteQr). POST so the token stays out of
// URLs and logs. Never cached, by the browser or anything between: each
// answer is one guest's credential. Its own two limiters, the program's
// shape (rate-limit.middleware.ts).
router.post('/qr', rsvpQrIpLimiter, rsvpQrLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await rsvpService.getInviteQr(req.body?.token);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

// POST /api/rsvp/passes
// { token } → { passes: [{ personName, isPlusOne, day: { id, label, date },
// payload }] }: the accepted guest's door codes, one per person per day,
// issued on first ask (check-in-pass.service.ts's listForToken). POST so
// the token stays out of URLs and logs; never cached (each payload is a
// credential). Behind qrCheckIn. Its own two limiters, the QR code's shape.
router.post('/passes', requireFeature('qrCheckIn'), rsvpPassesIpLimiter, rsvpPassesLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await checkInPassService.listForToken(req.body?.token);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

// POST /api/rsvp/short-link
// { code } → { token }: a text message's short link (<site>/r/<code>),
// for the frontend's /r/:code page to open /rsvp?token=… (rsvp.service.ts's
// resolveShortLink). POST, and never cached: the answer is the guest's
// credential. The guessing backstop per IP in front, then per code
// (rate-limit.middleware.ts).
router.post('/short-link', shortLinkIpLimiter, shortLinkLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await rsvpService.resolveShortLink(req.body?.code);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

// POST /api/rsvp/submit
// Limited per invite (rsvpSubmitInviteLimiter): see rate-limit.middleware.ts.
router.post('/submit', rsvpSubmitInviteLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await rsvpService.submit(req.body);
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

// POST /api/rsvp/documents
// multipart: token, rsvpFieldId, file. A guest's file for one of the
// event's DOCUMENT questions, through this server (guest-document.service.ts
// checks what it really is and stores it privately). Answers 201 with the
// document; RSVP submit then names its id as that question's answer. The IP
// backstop before the file is read, the per-invite limit after (the token
// is in the multipart body).
router.post('/documents', documentUploadIpLimiter, receiveDocument, documentUploadInviteLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const document = await guestDocumentService.uploadForInvite(
      req.body?.token,
      req.body?.rsvpFieldId,
      req.file ? { buffer: req.file.buffer, originalname: req.file.originalname } : undefined
    );
    res.status(201).json({ status: 'ok', data: document });
  } catch (err) { next(err); }
});

// POST /api/rsvp/ticket-purchase/retry
// Body: { token }
// Re-initiates payment for an existing FAILED/EXPIRED ticket purchase —
// never resubmits the whole RSVP form. See rsvp.service.ts's
// retryTicketPayment.
// RETIRED (ticket sales Round B): 410 TICKET_PURCHASE_RETIRED.
router.post('/ticket-purchase/retry', (_req: Request, _res: Response, next: NextFunction) => next(ticketPurchaseRetired()));

// GET /api/rsvp/ticket-purchase/confirm/:token
// Called from the guest's Paystack callback landing page. Never trusts
// the callback's own query parameters as proof of payment — this makes
// an authoritative call back to Paystack if still PENDING. See
// rsvp.service.ts's confirmTicketPayment / ticketPurchaseService.reconcile.
// RETIRED (ticket sales Round B): 410 TICKET_PURCHASE_RETIRED. Existing
// purchases stay readable to the organiser (/api/ticket-purchases), and a
// late Paystack success on one is still recorded by the webhook.
router.get('/ticket-purchase/confirm/:token', (_req: Request, _res: Response, next: NextFunction) => next(ticketPurchaseRetired()));

export default router;
