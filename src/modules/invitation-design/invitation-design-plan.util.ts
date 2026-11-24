import { HttpError } from '../../shared/errors/http-error.js';
import { tenantRepository } from '../tenant/tenant.repository.js';
import { resolveEventPlan, type ResolvedPlan } from '../subscription-tier-config/effective-plan.util.js';
import { launchUnavailableMessage, tierRefusalMessage } from '../subscription-tier-config/tier-refusal-wording.util.js';
import { type EntitlementDerivableEvent } from '../event-pass/event-entitlement.util.js';
import { CANVAS_ERROR_CODES } from './canvas-design.constants.js';

// ─────────────────────────────────────────
//  THE PLAN GATE for CANVAS designs (STEERING "Invitation designs",
//  "Tier enforcement").
//
//  The plan setting invitationDesignsEnabled, read from the EVENT's plan
//  (resolveEventPlan: a Large Event Pass resolves to Elevate's settings, a
//  granted event to its feature set, a custom tier to its own). Saving a
//  CANVAS design and signing its uploads need it; reading one never does,
//  and neither does resetting to default. A design saved on a plan that had
//  it stays on the guests' invitations after a downgrade; the organiser
//  sees it as not editable, with this message.
//
//  The template engine (TEMPLATE, UPLOAD) is not gated: every plan had it,
//  and it is removed in a later round.
// ─────────────────────────────────────────

export const canvasNotOnPlanMessage = (plan: Pick<ResolvedPlan, 'name' | 'customTier'>): string =>
  tierRefusalMessage(
    `The ${plan.name} plan doesn't include invitation designs. Upgrade your plan to design your own invitation.`,
    launchUnavailableMessage('Invitation designs', { plural: true }),
    plan
  );

// The event's plan, or null when its tenant is gone (read as no plan).
export const designPlanFor = async (event: EntitlementDerivableEvent): Promise<ResolvedPlan | null> => {
  const tenant = await tenantRepository.findById(event.tenantId);
  return tenant ? resolveEventPlan(tenant, event) : null;
};

export const canDesignOn = (plan: ResolvedPlan | null): boolean => !!plan?.values.invitationDesignsEnabled;

// 422 INVITATION_DESIGNS_NOT_ON_PLAN, in the plan's own words.
export const assertCanvasDesignsOnPlan = async (event: EntitlementDerivableEvent): Promise<ResolvedPlan> => {
  const plan = await designPlanFor(event);
  if (!plan) throw new HttpError(404, 'Event not found');
  if (!canDesignOn(plan)) throw new HttpError(422, canvasNotOnPlanMessage(plan), CANVAS_ERROR_CODES.NOT_ON_PLAN);
  return plan;
};
