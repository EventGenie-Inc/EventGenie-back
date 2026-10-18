import { AsyncLocalStorage } from 'node:async_hooks';
import { type PlatformRole } from '@prisma/client';

// ─────────────────────────────────────────
//  REQUEST VIEWER — who is signed in, for the rest of this request
//
//  Set once, by `authenticate` (auth.middleware.ts), from the same row it
//  attaches as req.user, and readable anywhere downstream in that request
//  without being passed by hand. It exists for one reader: the assignment
//  lock (event-assignment-lock.util.ts), which needs the signed-in user's id inside
//  eventService's one scope resolver. Every router and service already
//  threads (role, tenantId) to that resolver, but not the user id; making
//  the lock depend on ~160 call sites each passing it correctly would mean
//  one forgotten argument is one leak. Read from here, no call site can
//  forget it.
//
//  Rules:
//  - Never a source of authorization by itself. Services still decide on
//    the role and tenantId they are passed; this only supplies identity to
//    a rule that already applies to that role.
//  - A reader that finds no viewer FAILS CLOSED (the lock treats a missing
//    viewer as "sees nothing"). That covers code run outside a request
//    (scripts, a test calling a service directly) and context lost across a
//    callback API (see bindRequestViewer).
//  - Node propagates this context through promises and async/await. It is
//    not guaranteed through callback-style APIs driven by stream events
//    (multer's upload callback is the one on an authenticated route today;
//    it kept the context in testing, and is bound anyway). Wrap such a
//    callback with bindRequestViewer.
// ─────────────────────────────────────────

export interface RequestViewer {
  userId: string;
  role: PlatformRole;
  tenantId: string | null;
}

const storage = new AsyncLocalStorage<RequestViewer>();

export const runAsRequestViewer = <T>(viewer: RequestViewer, fn: () => T): T => storage.run(viewer, fn);

export const getRequestViewer = (): RequestViewer | undefined => storage.getStore();

// Binds fn to the CURRENT viewer, so it runs with it even when called from
// a callback that has lost the async context.
export const bindRequestViewer = <A extends unknown[], R>(fn: (...args: A) => R): ((...args: A) => R) =>
  AsyncLocalStorage.bind(fn);
