// ─────────────────────────────────────────
//  HTTP ERROR
//
//  Thrown by services that need to control
//  their HTTP status/error code instead of
//  falling through to the global handler's
//  default 500. The global error handler
//  checks `instanceof HttpError` and uses
//  statusCode/code when present; any other
//  thrown Error still defaults to 500.
//
//  `details` (optional): structured data the client acts on, sent as the
//  body's `details` (e.g. the pending purchase a 409
//  PAYMENT_ALREADY_PENDING is about). Never a raw provider message.
// ─────────────────────────────────────────
export class HttpError extends Error {
  statusCode: number;
  code: string | undefined;
  details: Record<string, unknown> | undefined;

  constructor(statusCode: number, message: string, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}
