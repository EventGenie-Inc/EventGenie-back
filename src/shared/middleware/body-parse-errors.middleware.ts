import { type Request, type Response, type NextFunction } from 'express';
import { HttpError } from '../errors/http-error.js';

// ─────────────────────────────────────────
//  BODY PARSE ERRORS — malformed JSON and an oversized body
//
//  express.json() and express.urlencoded() fail a body they can't read
//  with an error carrying a `type`: 'entity.parse.failed' for JSON that
//  doesn't parse, 'entity.too.large' for a body over the limit. Left
//  alone, the global handler sees a plain error and answers 500, which
//  Sentry then reports: a client's mistake paged as our failure. Each is
//  bad input, so a coded 4xx instead. The parser's own messages are never
//  sent (a parse error's quotes the body).
//  Mounted directly after the body parsers; every other error passes on.
// ─────────────────────────────────────────

// The body parsers' limit (app.ts), in MB, and the one the 413 names.
export const REQUEST_BODY_LIMIT_MB = 10;

export const MALFORMED_JSON_CODE = 'MALFORMED_JSON';
export const MALFORMED_JSON_MESSAGE = "The request body isn't valid JSON.";

export const REQUEST_TOO_LARGE_CODE = 'REQUEST_TOO_LARGE';
export const REQUEST_TOO_LARGE_MESSAGE =
  `The request is too large. It must be ${REQUEST_BODY_LIMIT_MB}MB or smaller.`;

export const rejectBodyParseErrors = (err: unknown, _req: Request, _res: Response, next: NextFunction): void => {
  const type = (err as { type?: unknown } | null)?.type;
  if (type === 'entity.parse.failed') {
    next(new HttpError(400, MALFORMED_JSON_MESSAGE, MALFORMED_JSON_CODE));
    return;
  }
  if (type === 'entity.too.large') {
    next(new HttpError(413, REQUEST_TOO_LARGE_MESSAGE, REQUEST_TOO_LARGE_CODE));
    return;
  }
  next(err);
};
