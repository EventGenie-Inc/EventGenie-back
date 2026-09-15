// ─────────────────────────────────────────
//  MESSAGING ENGINE RESULT
//
//  Shared return contract for every delivery engine (sms.engine.ts,
//  email.engine.ts, and any future channel) so callers handle them
//  identically regardless of which SDK is underneath.
// ─────────────────────────────────────────

export interface EngineSendResult {
  ok: boolean;
  reason?: string;
}
