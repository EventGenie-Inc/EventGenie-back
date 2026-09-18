import {} from '@prisma/client';
// ─────────────────────────────────────────
//  BILLING HISTORY PRESENTER
//
//  The ledger is append-only and stores whatever a webhook or our own
//  code handed it — fine for a dispute, unreadable for a tenant admin
//  glancing at their billing history. This turns one entry into
//  (description, outcome) for display, tolerating whatever shape the
//  payload actually has (a raw Paystack webhook body for the *_SUCCEEDED/
//  *_FAILED cases, our own small object for the rest — see
//  subscription.service.ts's paymentLedgerService.record() call sites)
//  rather than assuming a fixed shape and throwing on a field that isn't
//  there.
//
//  Pure and synchronous, same shape as effective-tier.util.ts.
// ─────────────────────────────────────────
const TIER_LABEL = { SPARK: 'Spark', CELEBRATE: 'Celebrate', ELEVATE: 'Elevate' };
const PERIOD_LABEL = { MONTHLY: 'Monthly', ANNUAL: 'Annual' };
const isTier = (value) => typeof value === 'string' && value in TIER_LABEL;
const isPeriod = (value) => typeof value === 'string' && value in PERIOD_LABEL;
const planLabel = (tier, period) => {
    if (!isTier(tier))
        return null;
    return isPeriod(period) ? `${TIER_LABEL[tier]} (${PERIOD_LABEL[period]})` : TIER_LABEL[tier];
};
const asRecord = (value) => value && typeof value === 'object' ? value : {};
export const describeBillingHistoryEntry = (type, rawPayload) => {
    const payload = asRecord(rawPayload);
    switch (type) {
        case 'SUBSCRIPTION_CHARGE_SUCCEEDED':
            return { description: 'Subscription payment', outcome: 'SUCCESS' };
        case 'SUBSCRIPTION_CHARGE_FAILED': {
            const reason = typeof payload['reason'] === 'string' ? payload['reason'] : null;
            return {
                description: reason ? `Subscription payment failed — ${reason}` : 'Subscription payment failed',
                outcome: 'FAILED',
            };
        }
        case 'SUBSCRIPTION_TIER_CHANGED': {
            const from = asRecord(payload['from']);
            const to = payload['to'] !== undefined ? asRecord(payload['to']) : null;
            const pendingTo = payload['pendingTo'] !== undefined ? asRecord(payload['pendingTo']) : null;
            const fromLabel = planLabel(from['tier'], from['period']);
            if (to) {
                const toLabel = planLabel(to['tier'], to['period']);
                return {
                    description: fromLabel && toLabel ? `Plan changed: ${fromLabel} → ${toLabel}` : 'Plan changed',
                    outcome: 'SUCCESS',
                };
            }
            if (pendingTo) {
                const pendingLabel = planLabel(pendingTo['tier'], pendingTo['period']);
                return {
                    description: fromLabel && pendingLabel ? `Downgrade scheduled: ${fromLabel} → ${pendingLabel}` : 'Downgrade scheduled',
                    outcome: 'INFO',
                };
            }
            return { description: 'Plan changed', outcome: 'INFO' };
        }
        case 'SUBSCRIPTION_CANCELLED':
            return { description: 'Subscription cancelled', outcome: 'INFO' };
        case 'EVENT_PASS_PURCHASE_SUCCEEDED': {
            const isUpgrade = payload['isUpgrade'] === true;
            const passTier = typeof payload['passTier'] === 'string' ? payload['passTier'] : null;
            return {
                description: passTier ? `Event Pass ${isUpgrade ? 'upgraded to' : 'purchased'}: ${passTier}` : 'Event Pass purchased',
                outcome: 'SUCCESS',
            };
        }
        case 'EVENT_PASS_PURCHASE_FAILED': {
            const summary = typeof payload['summary'] === 'string' ? payload['summary'] : null;
            return { description: summary ? `Event Pass purchase failed — ${summary}` : 'Event Pass purchase failed', outcome: 'FAILED' };
        }
        case 'SMS_BUNDLE_PURCHASE_SUCCEEDED': {
            const smsCount = typeof payload['smsCount'] === 'number' ? payload['smsCount'] : null;
            return { description: smsCount ? `SMS bundle purchased: ${smsCount} credits` : 'SMS bundle purchased', outcome: 'SUCCESS' };
        }
        case 'SMS_BUNDLE_PURCHASE_FAILED': {
            const summary = typeof payload['summary'] === 'string' ? payload['summary'] : null;
            return { description: summary ? `SMS bundle purchase failed — ${summary}` : 'SMS bundle purchase failed', outcome: 'FAILED' };
        }
        default:
            return { description: type, outcome: 'INFO' };
    }
};
//# sourceMappingURL=billing-history-presenter.util.js.map