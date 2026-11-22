import { type PlatformRole } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { eventService } from '../event/event.service.js';
import { paymentAccountRepository } from '../payment-account/payment-account.repository.js';
import { resolveEventPlan } from '../subscription-tier-config/effective-plan.util.js';
import { paidTicketingRefusal } from '../subscription-tier-config/event-tier-enforcement.util.js';
import { eventTicketsSold } from '../ticket/ticket-sales-count.util.js';
import { HAVE_SALES_MESSAGE, PUBLIC_ONLY_MESSAGE, TICKET_SALES_ERROR_CODES } from './ticket-sales-rules.util.js';

// ─────────────────────────────────────────
//  THE PAID SWITCH (ticket sales Round A, 2026-11; STEERING "Ticket sales")
//
//  GET/PUT /api/events/:eventId/ticket-sales — event admins of the event
//  (tenant scoping and the assignment lock, through eventService), behind
//  `ticketing`. Switching ticket sales ON is what makes an event paid
//  (Event.ticketing PAID); nothing else does (ticket-sales-rules.util.ts).
//
//  On needs, checked in this order, each its own code:
//   - the event not cancelled or finished (409);
//   - a public event (422 TICKET_SALES_PUBLIC_ONLY);
//   - the event's plan allows it: paidTicketingEnabled on its effective plan
//     (403 TICKET_SALES_NOT_ON_PLAN, the plan's own wording);
//   - an active payout account (422 TICKET_SALES_PAYOUT_ACCOUNT_REQUIRED);
//   - at least one ACTIVE ticket type (422 TICKET_SALES_ACTIVE_TYPE_REQUIRED);
//   - registration approval off: buying a ticket is the approval (422
//     TICKET_SALES_REGISTRATION_APPROVAL_ON).
//  (The `ticketing` flag itself is the route's: off, a 404.)
//
//  While on: free registration is closed (registration-rules.util.ts), the
//  public page shows the ticket types (event-public.service.ts), no RSVP
//  check-in passes are issued (the ticket will be the pass:
//  check-in-pass-kinds.ts), and registration approval can't be switched on.
//
//  Off: allowed freely until a ticket is sold, refused after (409
//  TICKET_SALES_HAVE_SALES): pause instead (salesPaused).
//
//  The plan is checked ONLY when sales are switched on. Once paid, an event
//  keeps selling whatever happens to its organisation's plan (a downgrade,
//  a lapse to Spark): event saves re-sending PAID pass, publishing doesn't
//  re-check it, resuming after a pause doesn't either (it still needs an
//  active payout account and an active ticket type), and Round B's checkout
//  must not re-check it.
// ─────────────────────────────────────────

export interface TicketSalesRequirements {
  publicEvent: boolean;
  planAllowsTicketSales: boolean;
  payoutAccountActive: boolean;
  activeTicketType: boolean;
  registrationApprovalOff: boolean;
}

export interface TicketSalesView {
  enabled: boolean;
  paused: boolean;
  ticketsSold: number;
  // Whether switching on would succeed now, and what is still missing.
  canEnable: boolean;
  requirements: TicketSalesRequirements;
  // Whether switching off is allowed (nothing sold).
  canDisable: boolean;
}

type ScopedEvent = Awaited<ReturnType<typeof eventService.getScopedWithPass>>;

const payoutRequiredError = (): HttpError =>
  new HttpError(
    422,
    'Ticket sales need an active payout account. Add your bank details under payout settings first.',
    TICKET_SALES_ERROR_CODES.PAYOUT_ACCOUNT_REQUIRED
  );
const activeTypeRequiredError = (): HttpError =>
  new HttpError(422, 'Add a ticket type that is on sale (not hidden) first.', TICKET_SALES_ERROR_CODES.ACTIVE_TYPE_REQUIRED);

const requirementsFor = async (event: ScopedEvent): Promise<{ requirements: TicketSalesRequirements; refusal: HttpError | null }> => {
  const tenant = await paymentAccountRepository.findStatusByTenantId(event.tenantId);
  if (!tenant) throw new HttpError(404, 'Event not found');
  const plan = await resolveEventPlan(tenant, event);
  const activeTypes = await prisma.ticket.count({ where: { eventId: event.id, isArchived: false, status: 'ACTIVE' } });

  const requirements: TicketSalesRequirements = {
    publicEvent: event.visibility === 'PUBLIC',
    planAllowsTicketSales: plan.values.paidTicketingEnabled,
    payoutAccountActive: tenant.paystackSubaccountStatus === 'ACTIVE' && tenant.paystackSubaccountCode !== null,
    activeTicketType: activeTypes > 0,
    registrationApprovalOff: event.registrationAutoApprove,
  };

  let refusal: HttpError | null = null;
  if (event.status === 'CANCELLED') {
    refusal = new HttpError(409, "This event has been cancelled, so it can't sell tickets.", TICKET_SALES_ERROR_CODES.EVENT_CANCELLED);
  } else if (event.status === 'COMPLETED') {
    refusal = new HttpError(409, "This event has already taken place, so it can't sell tickets.", TICKET_SALES_ERROR_CODES.EVENT_FINISHED);
  } else if (!requirements.publicEvent) {
    refusal = new HttpError(422, PUBLIC_ONLY_MESSAGE, TICKET_SALES_ERROR_CODES.PUBLIC_ONLY);
  } else if (!requirements.planAllowsTicketSales) {
    refusal = new HttpError(403, paidTicketingRefusal(plan, true), TICKET_SALES_ERROR_CODES.PLAN);
  } else if (!requirements.payoutAccountActive) {
    refusal = payoutRequiredError();
  } else if (!requirements.activeTicketType) {
    refusal = activeTypeRequiredError();
  } else if (!requirements.registrationApprovalOff) {
    refusal = new HttpError(
      422,
      'Turn off registration approval first: on an event that sells tickets, buying a ticket is the approval.',
      TICKET_SALES_ERROR_CODES.APPROVAL_ON
    );
  }
  return { requirements, refusal };
};

const viewOf = async (event: ScopedEvent): Promise<TicketSalesView> => {
  const [{ requirements, refusal }, ticketsSold] = await Promise.all([requirementsFor(event), eventTicketsSold(event.id)]);
  return {
    enabled: event.ticketing === 'PAID',
    paused: event.ticketing === 'PAID' && event.salesPaused,
    ticketsSold,
    canEnable: refusal === null,
    requirements,
    canDisable: ticketsSold === 0,
  };
};

const parseBody = (body: unknown): { enabled?: boolean; paused?: boolean } => {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'The request body must be an object.', TICKET_SALES_ERROR_CODES.INVALID);
  }
  const { enabled, paused } = body as { enabled?: unknown; paused?: unknown };
  if (enabled !== undefined && typeof enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false.', TICKET_SALES_ERROR_CODES.INVALID);
  if (paused !== undefined && typeof paused !== 'boolean') throw new HttpError(400, 'paused must be true or false.', TICKET_SALES_ERROR_CODES.INVALID);
  if (enabled === undefined && paused === undefined) throw new HttpError(400, 'Send enabled, paused, or both.', TICKET_SALES_ERROR_CODES.INVALID);
  return { ...(enabled !== undefined && { enabled }), ...(paused !== undefined && { paused }) };
};

export const ticketSalesService = {
  get: async (eventId: string, role: PlatformRole, tenantId: string | null): Promise<TicketSalesView> =>
    viewOf(await eventService.getScopedWithPass(eventId, role, tenantId)),

  // { enabled?: boolean, paused?: boolean }
  update: async (eventId: string, userId: string, role: PlatformRole, tenantId: string | null, body: unknown): Promise<TicketSalesView> => {
    const change = parseBody(body);
    const event = await eventService.getScopedWithPass(eventId, role, tenantId);
    const enabledAfter = change.enabled ?? event.ticketing === 'PAID';

    if (change.enabled === true && event.ticketing !== 'PAID') {
      const { refusal } = await requirementsFor(event);
      if (refusal) throw refusal;
    }
    if (change.enabled === false && event.ticketing === 'PAID' && (await eventTicketsSold(eventId)) > 0) {
      throw new HttpError(409, HAVE_SALES_MESSAGE, TICKET_SALES_ERROR_CODES.HAVE_SALES);
    }
    if (change.paused !== undefined && !enabledAfter) {
      throw new HttpError(422, "Ticket sales aren't switched on, so there is nothing to pause.", TICKET_SALES_ERROR_CODES.NOT_ENABLED);
    }
    // Resuming paused sales: never the plan (the event became paid while the
    // plan allowed it; a downgrade since doesn't stop it selling), but sales
    // still need somewhere to land and something to sell.
    if (change.paused === false && event.ticketing === 'PAID' && event.salesPaused && change.enabled !== false) {
      const { requirements } = await requirementsFor(event);
      if (!requirements.payoutAccountActive) throw payoutRequiredError();
      if (!requirements.activeTicketType) throw activeTypeRequiredError();
    }

    await prisma.event.update({
      where: { id: eventId },
      data: {
        ticketing: enabledAfter ? 'PAID' : 'FREE',
        // Switched on: selling, unless this request also pauses. Off: nothing
        // left to pause.
        salesPaused: enabledAfter ? (change.paused ?? (change.enabled === true && event.ticketing !== 'PAID' ? false : event.salesPaused)) : false,
        updatedBy: userId,
      },
    });
    return viewOf(await eventService.getScopedWithPass(eventId, role, tenantId));
  },
};
