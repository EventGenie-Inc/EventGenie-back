import { type CustomTierRequestStatus, type Prisma } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { sendEmail } from '../../shared/messaging/email.engine.js';
import { isValidEmail, normalizeEmail } from '../../shared/utils/email.util.js';
import { optionalWholeNumber } from '../../shared/utils/whole-number.util.js';
import {
  CONTACT_ERROR_CODES,
  PHONE_FORMAT_MESSAGE,
  normalizePhoneToE164,
  resolvePhoneCountry,
} from '../guest/guest-validation.util.js';
import { adminAuditService } from '../admin-audit/admin-audit.service.js';
import { ADMIN_AUDIT_ACTIONS } from '../admin-audit/admin-audit.types.js';
import { customTierRequestRepository } from './custom-tier-request.repository.js';
import { buildCustomTierRequestEmail, buildCustomTierRequestReplyEmail } from './custom-tier-email.util.js';
import {
  CUSTOM_TIER_REQUEST_ERROR_CODES as CODES,
  CUSTOM_TIER_REQUEST_STATUSES,
  NEEDS_MAX_LENGTH,
  NOTE_MAX_LENGTH,
  type CustomTierRequestInput,
  type CustomTierRequestUpdateInput,
} from './custom-tier.types.js';

// ─────────────────────────────────────────
//  REQUESTS FOR A CUSTOM TIER (STEERING "Custom tiers"; behind customTiers)
//
//  A tenant admin asks: what they need, roughly how many events and guests,
//  and who to talk to. Saved, then emailed to the admin address (Reply-To:
//  their contact); a failed email never loses the request (it's listed for
//  the super admin either way, and the response says whether it went).
//  The super admin moves it through NEW → IN_DISCUSSION → ACCEPTED or
//  DECLINED (any order) and may reply with a short note, emailed to the
//  contact. Each change is audit-logged against the tenant.
// ─────────────────────────────────────────

const CONTACT_NAME_MAX_LENGTH = 100;

// The contact phone follows every other number's rules (guest-validation.util.ts):
// a number without a country code is read in contactPhoneCountry (ISO code,
// South Africa when none), saved in international form (E.164). A bad number
// is 422 CONTACT_PHONE_INVALID, an unknown country 422
// CONTACT_PHONE_COUNTRY_INVALID (re-raised from the shared 400s, as at
// registration). Optional: blank means none.
const parseContactPhone = (value: unknown, country: unknown): string | null => {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return null;
  try {
    if (typeof value !== 'string') throw new HttpError(400, PHONE_FORMAT_MESSAGE, CONTACT_ERROR_CODES.PHONE_INVALID);
    return normalizePhoneToE164(value, resolvePhoneCountry(country));
  } catch (err) {
    if (err instanceof HttpError && err.statusCode === 400) throw new HttpError(422, err.message, err.code);
    throw err;
  }
};

const requiredText = (value: unknown, max: number, message: string): string => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max) throw new HttpError(422, message);
  return text;
};

const parseRequest = (body: CustomTierRequestInput) => {
  const needs = requiredText(body.needs, NEEDS_MAX_LENGTH, `Tell us what you need, in up to ${NEEDS_MAX_LENGTH} characters.`);
  const expectedEvents = optionalWholeNumber(body.expectedEvents, 'Enter roughly how many events, as a whole number, or leave it blank.');
  const expectedGuests = optionalWholeNumber(body.expectedGuests, 'Enter roughly how many guests, as a whole number, or leave it blank.');
  const contactName = requiredText(body.contactName, CONTACT_NAME_MAX_LENGTH, 'Enter the name of the person we should talk to.');
  const contactEmail = normalizeEmail(typeof body.contactEmail === 'string' ? body.contactEmail : '');
  if (!isValidEmail(contactEmail)) throw new HttpError(422, 'Enter an email address we can reply to.');
  return { needs, expectedEvents, expectedGuests, contactName, contactEmail, contactPhone: parseContactPhone(body.contactPhone, body.contactPhoneCountry) };
};

const parseStatus = (value: unknown): CustomTierRequestStatus => {
  if (typeof value !== 'string' || !CUSTOM_TIER_REQUEST_STATUSES.includes(value as CustomTierRequestStatus)) {
    throw new HttpError(422, `Status must be one of ${CUSTOM_TIER_REQUEST_STATUSES.join(', ')}.`, CODES.STATUS_INVALID);
  }
  return value as CustomTierRequestStatus;
};

export const customTierRequestService = {
  // POST /api/custom-tier-requests (tenant admin). 201 with the request and
  // adminNotified (whether the email to the admin address went).
  create: async (tenantId: string, userId: string, body: CustomTierRequestInput) => {
    const data = parseRequest(body ?? {});
    const request = await customTierRequestRepository.create({ ...data, tenantId, requestedByUserId: userId });
    const result = await sendEmail(buildCustomTierRequestEmail({ organisationName: request.tenant.name, ...data }));
    if (!result.ok) console.error(`[custom tier requests] the email for request ${request.id} failed: ${result.reason}`);
    const { tenant: _tenant, ...view } = request;
    return { ...view, adminNotified: result.ok };
  },

  // GET /api/custom-tier-requests (tenant admin): their own, newest first.
  listForTenant: (tenantId: string) => customTierRequestRepository.findForTenant(tenantId),

  // GET /api/admin/custom-tier-requests[?status=NEW] (super admin).
  list: async (status: unknown) =>
    customTierRequestRepository.findAll(status === undefined || status === '' ? null : parseStatus(status)),

  // PATCH /api/admin/custom-tier-requests/:id { status?, note? } (super
  // admin). A note is emailed to the contact; the response says whether it
  // went (noteEmailed, null when there was no note).
  update: async (id: string, body: CustomTierRequestUpdateInput, actorUserId: string, now: Date = new Date()) => {
    const b = body ?? {};
    const status = b.status === undefined ? undefined : parseStatus(b.status);
    const note = b.note === undefined ? undefined : requiredText(b.note, NOTE_MAX_LENGTH, `Write a note of up to ${NOTE_MAX_LENGTH} characters.`);
    if (status === undefined && note === undefined) {
      throw new HttpError(422, 'Send a new status, a note, or both.', CODES.NOTHING_TO_UPDATE);
    }

    const updated = await prisma.$transaction(async (tx) => {
      const before = await customTierRequestRepository.findById(id, tx);
      if (!before) throw new HttpError(404, 'Request not found', CODES.NOT_FOUND);
      const data: Prisma.CustomTierRequestUpdateInput = {
        ...(status !== undefined && { status }),
        ...(note !== undefined && { adminNote: note, adminNoteAt: now }),
      };
      const after = await customTierRequestRepository.update(id, data, tx);
      await adminAuditService.record(
        {
          actorUserId,
          tenantId: before.tenantId,
          action: ADMIN_AUDIT_ACTIONS.CUSTOM_TIER_REQUEST_UPDATED,
          details: { requestId: id, ...(status !== undefined && { status: { before: before.status, after: status } }), ...(note !== undefined && { note }) },
        },
        tx
      );
      return after;
    });

    let noteEmailed: boolean | null = null;
    if (note !== undefined) {
      const result = await sendEmail(
        buildCustomTierRequestReplyEmail({ to: updated.contactEmail, contactName: updated.contactName, organisationName: updated.tenant.name, note })
      );
      noteEmailed = result.ok;
      if (!result.ok) console.error(`[custom tier requests] the reply to request ${id} failed: ${result.reason}`);
    }
    return { ...updated, noteEmailed };
  },
};
