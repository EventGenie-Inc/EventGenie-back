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
// ─────────────────────────────────────────
export class HttpError extends Error {
    statusCode;
    code;
    constructor(statusCode, message, code) {
        super(message);
        this.name = 'HttpError';
        this.statusCode = statusCode;
        this.code = code;
    }
}
//# sourceMappingURL=http-error.js.map