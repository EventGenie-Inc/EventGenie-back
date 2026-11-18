import { AsyncLocalStorage } from 'async_hooks';

// ─────────────────────────────────────────
//  Per request: whether the service that acted already wrote an audit entry
//  (with the details only it knows). The catch-all middleware
//  (admin-audit.middleware.ts) records a super admin's write itself only
//  when none was, so an action is never recorded twice.
// ─────────────────────────────────────────

interface AuditRequestState {
  recorded: boolean;
}

const storage = new AsyncLocalStorage<AuditRequestState>();

export const runWithAuditState = <T>(fn: () => T): { state: AuditRequestState; result: T } => {
  const state: AuditRequestState = { recorded: false };
  return { state, result: storage.run(state, fn) };
};

export const markAuditRecorded = (): void => {
  const state = storage.getStore();
  if (state) state.recorded = true;
};
