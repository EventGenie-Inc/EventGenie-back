import crypto from 'crypto';
import prisma from '../../shared/prisma/prisma.client.js';
import { smsDeliveryRepository } from './sms-delivery.repository.js';
import { type DeliveryReportOutcome, type ReportVerdict, type SmsPortalDeliveryReport } from './sms-delivery.types.js';

// ─────────────────────────────────────────
//  SMSPORTAL DELIVERY REPORTS
//
//  SMSPortal posts a delivery report (DLR) for each text to the webhook set
//  up in its Control Panel (Settings > Webhooks; it can't be set by API):
//  POST <API>/api/sms/delivery-reports, JSON.
//
//  SECURED BY SMSPORTAL'S WEBHOOK SIGNATURE (docs: "Webhook signatures"),
//  switched on in the same place ("Activate Signatures"). Each request
//  carries
//    SmsWebhookEngine-Signature  v1,hmac_sha256=<UPPERCASE HEX>
//    SmsWebhookEngine-Timestamp  Unix seconds
//  and the signature is HMAC-SHA256, keyed with the Signature Secret Key
//  (base64, as SMSPortal shows it; SMSPORTAL_WEBHOOK_SECRET), over
//    v1:{timestamp}|{METHOD}|{full URL with query}|{raw body}
//  The raw bytes are checked (req.rawBody), never a re-serialised body. A
//  missing secret, a missing or wrong signature, or a timestamp more than
//  SIGNATURE_TOLERANCE_SECONDS away: 401, nothing read or written. Never
//  logged: the secret, the signature, the body.
//
//  Status (docs: "Delivery statuses"): DELIVRD is DELIVERED; UNDELIV,
//  EXPIRED, BLIST, CANCELLED, NOROUTE are FAILED, with the reason in words;
//  SUBMITD and STAGED are on the way, and ignored. The text is matched by
//  customerId (our queue item's id), else by eventId. A DELIVERED is never
//  overwritten by a later FAILED. The invite's smsStatus (what the organiser
//  sees per guest) follows its most recent text only.
//
//  A text that ended FAILED as unconfirmed (no clear answer from SMSPortal,
//  so never re-sent) and then gets a report went after all: it becomes SENT,
//  its parts are counted (once), an invitation marks the invite delivered,
//  and a reminder logs a sent row.
//
//  Answers 200 for any signed report, ours or not ("Always return an HTTP
//  2xx response, to prevent retries"); 500 only when recording failed, so
//  SMSPortal tries again.
// ─────────────────────────────────────────

export const SMSPORTAL_WEBHOOK_SECRET_ENV = 'SMSPORTAL_WEBHOOK_SECRET';
export const SIGNATURE_TOLERANCE_SECONDS = 10 * 60;

const FAILED_REASONS: Record<string, string> = {
  UNDELIV: "The guest's network couldn't deliver the text.",
  EXPIRED: "The text expired before the guest's phone could receive it (switched off or out of reach).",
  BLIST: 'This number is blocked from receiving texts (blacklisted or opted out).',
  CANCELLED: 'The text was cancelled before it was delivered.',
  NOROUTE: 'There is no route to this number on any network.',
};

export const verdictFor = (status: string | undefined): ReportVerdict => {
  const code = (status ?? '').trim().toUpperCase();
  if (code === 'DELIVRD') return { status: 'DELIVERED', reason: null };
  if (FAILED_REASONS[code]) return { status: 'FAILED', reason: FAILED_REASONS[code]! };
  return null;
};

// Reads a field whether the template sent it camelCase or PascalCase.
const field = (report: Record<string, unknown>, name: string): unknown =>
  report[name] ?? report[name.charAt(0).toUpperCase() + name.slice(1)];

const asText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : typeof value === 'number' ? String(value) : null;

const normalise = (raw: unknown): SmsPortalDeliveryReport | null => {
  if (!raw || typeof raw !== 'object') return null;
  const report = raw as Record<string, unknown>;
  const parts = Number(field(report, 'sentDataPartsCount'));
  return {
    customerId: asText(field(report, 'customerId')) ?? undefined,
    eventId: asText(field(report, 'eventId')) ?? undefined,
    status: asText(field(report, 'status')) ?? undefined,
    ...(Number.isInteger(parts) && parts > 0 ? { sentDataPartsCount: parts } : {}),
  };
};

export const smsDeliveryService = {
  // The signature check, on the exact bytes received.
  isValidSignature: (input: {
    rawBody: Buffer | undefined;
    method: string;
    url: string;
    signature: string | string[] | undefined;
    timestamp: string | string[] | undefined;
    now?: Date;
  }): boolean => {
    const secret = process.env[SMSPORTAL_WEBHOOK_SECRET_ENV]?.trim();
    if (!secret) {
      console.error(`[sms delivery] ${SMSPORTAL_WEBHOOK_SECRET_ENV} is not set: every delivery report is refused`);
      return false;
    }
    if (!input.rawBody || typeof input.signature !== 'string' || typeof input.timestamp !== 'string') return false;

    const timestamp = Number(input.timestamp);
    const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
    if (!Number.isInteger(timestamp) || Math.abs(nowSeconds - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;

    const match = /^v1,hmac_sha256=([0-9A-Fa-f]{64})$/.exec(input.signature.trim());
    if (!match) return false;

    const canonical = `v1:${input.timestamp}|${input.method.toUpperCase()}|${input.url}|${input.rawBody.toString('utf8')}`;
    const expected = crypto.createHmac('sha256', Buffer.from(secret, 'base64')).update(canonical, 'utf8').digest('hex').toUpperCase();
    const given = match[1]!.toUpperCase();
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
  },

  // Records every report in the body (one, or a list).
  process: async (body: unknown, now: () => Date = () => new Date()): Promise<DeliveryReportOutcome> => {
    const reports = (Array.isArray(body) ? body : [body]).map(normalise);
    const outcome: DeliveryReportOutcome = { received: reports.length, recorded: 0, ignored: 0 };

    for (const report of reports) {
      const verdict = verdictFor(report?.status);
      const found =
        report && verdict
          ? await smsDeliveryRepository.findItem(report.customerId ?? null, report.eventId != null ? String(report.eventId) : null)
          : null;
      if (!report || !verdict || !found) {
        outcome.ignored += 1;
        continue;
      }

      const recorded = await prisma.$transaction(async (tx) => {
        await smsDeliveryRepository.lockItem(tx, found.id);
        const item = await smsDeliveryRepository.findItemTx(tx, found.id);
        if (!item) return false;
        const at = now();

        // Unconfirmed, and the report proves it went: SENT after all.
        const unconfirmed = item.status === 'FAILED' && item.providerCallAt !== null;
        if (item.status !== 'SENT' && !unconfirmed) return false;
        if (unconfirmed) {
          const parts = report.sentDataPartsCount ?? 1;
          await smsDeliveryRepository.confirmSent(tx, item.id, {
            at,
            providerMessageId: item.providerMessageId ?? (report.eventId != null ? String(report.eventId) : null),
            parts,
          });
          await smsDeliveryRepository.logSentOnce(tx, {
            tenantId: item.invite.event.tenantId,
            eventId: item.eventId,
            inviteId: item.inviteId,
            source: item.smsSource ?? 'QUOTA',
            parts,
            emailSendItemId: item.id,
          });
          if (item.kind === 'INVITATION') await smsDeliveryRepository.markInviteDelivered(tx, item.inviteId, at);
          else await smsDeliveryRepository.logReminderSent(tx, { tenantId: item.invite.event.tenantId, eventId: item.eventId, inviteId: item.inviteId, sentBy: item.send.createdBy });
        }

        // DELIVERED is final: a late or repeated FAILED doesn't undo it.
        if (item.deliveryStatus === 'DELIVERED' && verdict.status === 'FAILED') return false;
        await smsDeliveryRepository.setDelivery(tx, item.id, verdict.status, verdict.reason, at);
        if (await smsDeliveryRepository.isLatestTextFor(tx, item.inviteId, item.id)) {
          await smsDeliveryRepository.setInviteSmsStatus(tx, item.inviteId, verdict.status, verdict.reason, at);
        }
        return true;
      });
      if (recorded) outcome.recorded += 1;
      else outcome.ignored += 1;
    }
    return outcome;
  },
};
