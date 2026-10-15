import { type Request, type Response, type NextFunction } from 'express';
import { HttpError } from '../errors/http-error.js';

// ─────────────────────────────────────────
//  MALFORMED JSON
//
//  express.json() fails a body it can't parse with a SyntaxError of type
//  'entity.parse.failed'. Left alone, the global handler sees a plain
//  error and answers 500, which Sentry then reports: a client's typo
//  paged as our failure. It is malformed input, so a coded 400 instead.
//  The parser's own message quotes the body, so it is never sent.
//  Mounted directly after the body parsers; every other error passes on.
// ─────────────────────────────────────────

export const MALFORMED_JSON_CODE = 'MALFORMED_JSON';
export const MALFORMED_JSON_MESSAGE = "The request body isn't valid JSON.";

export const rejectMalformedJson = (err: unknown, _req: Request, _res: Response, next: NextFunction): void => {
  if ((err as { type?: unknown } | null)?.type === 'entity.parse.failed') {
    next(new HttpError(400, MALFORMED_JSON_MESSAGE, MALFORMED_JSON_CODE));
    return;
  }
  next(err);
};
