import * as Sentry from '@sentry/node';
import { type Request, type Response, type NextFunction } from 'express';
import { HttpError } from '../errors/http-error.js';
import { scrubUrl } from './sentry-scrub.js';

// ─────────────────────────────────────────
//  ERROR REPORTING — what reaches Sentry
//
//  Every unexpected error and every 5xx is reported. An HttpError below
//  500 is NOT: a 404 for another tenant's event, a 422 on a form, a 429 on
//  the announcement limit are the app working as designed, and reporting
//  them would bury real failures. shouldReportError is the one rule.
//
//  The user is attached as id, role and tenantId only (never email, name
//  or phone); the scrubber drops anything else that reaches `user`.
//
//  With no SENTRY_DSN, Sentry is never initialised and all of this is a
//  no-op.
// ─────────────────────────────────────────

export const shouldReportError = (err: unknown): boolean =>
  !(err instanceof HttpError && err.statusCode < 500);

// Set on res.locals once a request's error has been reported.
const REPORTED = 'errorReported';

type ReportableRequest = Pick<Request, 'method' | 'originalUrl' | 'baseUrl' | 'route' | 'user'>;

const routeName = (req: ReportableRequest): string => {
  // The route pattern (/api/rsvp/validate/:token) names no credential;
  // fall back to the scrubbed URL when no route matched. By the time the
  // global error handler runs, Express has reset req.baseUrl, so the mount
  // path is the URL's path minus as many segments as the pattern has.
  const pattern = req.route?.path;
  const path = scrubUrl(req.originalUrl);
  if (typeof pattern !== 'string') return `${req.method} ${path}`;
  const patternSegments = pattern.split('/').filter(Boolean).length;
  const pathSegments = path.split('/').filter(Boolean);
  const mount = req.baseUrl || `/${pathSegments.slice(0, Math.max(0, pathSegments.length - patternSegments)).join('/')}`;
  return `${req.method} ${`${mount}${pattern}`.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1')}`;
};

const withRequestScope = (req: ReportableRequest | undefined, capture: () => void): void => {
  Sentry.withScope((scope) => {
    if (req) {
      const route = routeName(req);
      scope.setTag('route', route);
      scope.setTransactionName(route);
      scope.addEventProcessor((event) => ({
        ...event,
        request: { ...event.request, method: req.method, url: scrubUrl(req.originalUrl) },
      }));
      if (req.user) {
        scope.setUser({ id: req.user.id, role: req.user.role, tenantId: req.user.tenantId });
      }
    }
    capture();
  });
};

// Reports err unless it is an expected refusal. Returns whether it was sent.
export const reportError = (err: unknown, req?: ReportableRequest, res?: Response): boolean => {
  if (!Sentry.isInitialized() || !shouldReportError(err)) return false;
  withRequestScope(req, () => {
    Sentry.captureException(err);
  });
  if (res) res.locals[REPORTED] = true;
  return true;
};

// For a 5xx that is an expected, explained state rather than a failure
// (the system health endpoint saying Sentry isn't connected): the safety
// net below leaves it alone.
export const skipServerErrorReport = (res: Response): void => {
  res.locals[REPORTED] = true;
};

// Safety net for a 5xx a handler sent itself, without an error reaching
// the global handler (the Paystack webhook's deliberate 500 is one): any
// 5xx response not already reported is reported here as a message.
export const reportUnreportedServerErrors = (req: Request, res: Response, next: NextFunction): void => {
  res.on('finish', () => {
    if (res.statusCode < 500 || res.locals[REPORTED] === true) return;
    if (!Sentry.isInitialized()) return;
    withRequestScope(req, () => {
      Sentry.captureMessage(`${routeName(req)} responded ${res.statusCode}`, 'error');
    });
  });
  next();
};
