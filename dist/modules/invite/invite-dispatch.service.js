import {} from '@prisma/client';
import { inviteRepository } from './invite.repository.js';
import { inviteService } from './invite.service.js';
import { eventService } from '../event/event.service.js';
import { assertSmsSendable } from '../subscription-tier-config/sms-tier-enforcement.util.js';
import { smsSendLogRepository } from '../sms-send-log/sms-send-log.repository.js';
import { sendSms } from '../../shared/messaging/sms.engine.js';
import { sendEmail } from '../../shared/messaging/email.engine.js';
import { buildInviteRsvpLink, buildInviteEmailSubject, buildInviteEmailHtml, buildInviteSmsBody, } from './invite-message.util.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { assertEventIsPublished } from '../event/event-status.util.js';
const guestDisplayName = (guest) => [guest.firstName, guest.surname].filter(Boolean).join(' ').trim() || 'Guest';
const contactFor = (invite) => invite.deliveryMethod === 'EMAIL' ? (invite.guest.email ?? '') : (invite.guest.phoneNumber ?? '');
// PUBLIC events don't use invites — they use the share link (Task 5) and
// guests self-create on RSVP. Applies to both a fresh send and a resend.
const assertEventAcceptsInvites = (visibility) => {
    if (visibility !== 'PRIVATE') {
        throw new HttpError(400, "Public events don't use invites — share the event's public link instead (GET /api/events/:eventId/share-link).");
    }
};
const earliestDayLabel = (eventDays) => {
    if (!eventDays.length)
        return null;
    const earliest = eventDays.reduce((a, b) => (a.date < b.date ? a : b));
    return earliest.date.toLocaleDateString('en-ZA', { year: 'numeric', month: 'long', day: 'numeric' });
};
const dispatchOne = async (eventTenantId, eventName, location, dateLabel, invite) => {
    const rsvpLink = buildInviteRsvpLink(invite.token);
    const result = invite.deliveryMethod === 'EMAIL'
        ? await sendEmail(invite.guest.email ?? '', buildInviteEmailSubject(eventName), buildInviteEmailHtml(eventName, location, dateLabel, rsvpLink))
        : await sendSms(invite.guest.phoneNumber ?? '', buildInviteSmsBody(eventName, rsvpLink));
    if (!result.ok)
        return { ok: false, reason: result.reason ?? 'Delivery failed' };
    // Only marked delivered on real dispatch success — a resend remains
    // possible for anything that fails here, since deliveredAt stays null.
    await inviteRepository.markDelivered(invite.id);
    if (invite.deliveryMethod === 'SMS') {
        await smsSendLogRepository.create(eventTenantId, invite.id);
    }
    return { ok: true };
};
export const inviteDispatchService = {
    sendBulk: async (eventId, guestIds, requestingRole, tenantId) => {
        const event = await eventService.getById(eventId, requestingRole, tenantId);
        // Status is checked first — before visibility, before guestIds is
        // even validated, and well before the guest list is loaded or the
        // SMS tier check runs. A draft event must fail fast on status, not
        // after doing work or telling the organiser about their SMS quota.
        assertEventIsPublished(event.status);
        assertEventAcceptsInvites(event.visibility);
        if (!guestIds?.length) {
            throw new HttpError(400, 'guestIds is required');
        }
        // Guest-ownership/eligibility pre-flight — wrong event, archived
        // guest, or archived invite all land here, and reject the WHOLE
        // request (nobody in the batch is dispatched), before any tier check.
        const invites = await inviteRepository.findByGuestIds(eventId, guestIds);
        const foundGuestIds = new Set(invites.map((i) => i.guestId));
        const missing = guestIds.filter((id) => !foundGuestIds.has(id));
        if (missing.length) {
            throw new HttpError(400, `${missing.length} guest(s) are not eligible for sending — they may be archived, have an ` +
                `archived invite, or belong to a different event: ${missing.join(', ')}`);
        }
        // Tier check — all-or-nothing, evaluated BEFORE any dispatch begins.
        const smsCount = invites.filter((i) => i.deliveryMethod === 'SMS').length;
        await assertSmsSendable(event.tenantId, smsCount);
        const dateLabel = earliestDayLabel(event.eventDays);
        const failures = [];
        let sent = 0;
        // Sequential, not Promise.all — avoids bursting Twilio/Resend rate
        // limits and keeps SmsSendLog writes ordered per tenant. Partial
        // failure is expected and fine here (a different category from the
        // pre-flight rejects above): one bad phone number must not abort the
        // rest of the batch.
        for (const invite of invites) {
            const result = await dispatchOne(event.tenantId, event.name, event.location, dateLabel, invite);
            if (result.ok) {
                sent += 1;
            }
            else {
                failures.push({
                    guestId: invite.guestId,
                    name: guestDisplayName(invite.guest),
                    contact: contactFor(invite),
                    reason: result.reason,
                });
            }
        }
        return { totalSelected: guestIds.length, sent, failed: failures.length, failures };
    },
    resend: async (inviteId, requestingRole, tenantId) => {
        const invite = await inviteService.getById(inviteId, requestingRole, tenantId);
        const event = await eventService.getById(invite.eventId, requestingRole, tenantId);
        assertEventIsPublished(event.status);
        assertEventAcceptsInvites(event.visibility);
        // A resend still costs a real SMS — re-check the tier rules for a
        // batch-of-one before dispatching.
        if (invite.deliveryMethod === 'SMS') {
            await assertSmsSendable(event.tenantId, 1);
        }
        const dateLabel = earliestDayLabel(event.eventDays);
        // Dispatches using the invite's EXISTING token — never regenerated,
        // so a guest who opens an old link days later doesn't find it dead.
        const result = await dispatchOne(event.tenantId, event.name, event.location, dateLabel, invite);
        return {
            guestId: invite.guestId,
            name: guestDisplayName(invite.guest),
            contact: contactFor(invite),
            deliveryMethod: invite.deliveryMethod,
            ok: result.ok,
            ...(result.ok ? {} : { reason: result.reason }),
        };
    },
};
//# sourceMappingURL=invite-dispatch.service.js.map