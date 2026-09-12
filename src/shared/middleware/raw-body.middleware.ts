import { type Request, type Response } from 'express';

// ─────────────────────────────────────────
//  RAW BODY CAPTURE
//
//  Paystack's webhook signature is an HMAC over the exact bytes it
//  sent — not a re-serialised JSON.stringify(req.body), which can
//  differ in key order/whitespace and silently break every signature.
//  app.ts's global express.json() parser consumes the request stream
//  before any router sees it, so the raw buffer would otherwise be
//  gone by the time payment-webhook.router.ts runs.
//
//  express.json()'s own `verify` option runs during parsing, with the
//  raw buffer still in hand, before req.body is set — passing this as
//  that option stashes the buffer on the request for every request
//  (cheap: a reference, not a copy) so payment-webhook.router.ts (or
//  any future route needing the same guarantee) can read it back via
//  req.rawBody without route-ordering games.
// ─────────────────────────────────────────

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

export const captureRawBody = (req: Request, _res: Response, buf: Buffer): void => {
  req.rawBody = buf;
};
