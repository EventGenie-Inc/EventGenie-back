import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireFeature } from '../../shared/middleware/feature.middleware.js';
import { rsvpService } from './rsvp.service.js';
import { eventProgramService } from '../event-program/event-program.service.js';
import {
  ticketQuoteLimiter,
  rsvpProgramLimiter,
  rsvpProgramIpLimiter,
  rsvpSubmitInviteLimiter,
  documentUploadInviteLimiter,
  documentUploadIpLimiter,
} from '../../shared/middleware/rate-limit.middleware.js';
import { guestDocumentService } from '../guest-document/guest-document.service.js';
import { receiveDocument } from '../guest-document/guest-document.router.js';

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
router.post('/ticket-quote', requireFeature('ticketing'), ticketQuoteLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const quote = await rsvpService.quoteTicket(req.body);
    res.status(200).json({ status: 'ok', data: quote });
  } catch (err) { next(err); }
});

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
router.post('/ticket-purchase/retry', requireFeature('ticketing'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await rsvpService.retryTicketPayment(req.body?.token as string);
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

// GET /api/rsvp/ticket-purchase/confirm/:token
// Called from the guest's Paystack callback landing page. Never trusts
// the callback's own query parameters as proof of payment — this makes
// an authoritative call back to Paystack if still PENDING. See
// rsvp.service.ts's confirmTicketPayment / ticketPurchaseService.reconcile.
router.get('/ticket-purchase/confirm/:token', requireFeature('ticketing'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await rsvpService.confirmTicketPayment(req.params['token'] as string);
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

export default router;
