import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { guestService } from '../../src/modules/guest/guest.service.js';
import { GUEST_EMAIL_REQUIRED_MESSAGE } from '../../src/modules/guest/guest-validation.util.js';
import {
  createTestTenant,
  deleteTestTenant,
  createTestUserRow,
  deleteTestUserRow,
  createTestEvent,
  deleteTestEvent,
  createTestEventDay,
  deleteTestGuest,
  prisma,
} from '../helpers/fixtures.js';

// ─────────────────────────────────────────
//  LAUNCH MODE — with sms off, every organiser-managed guest needs an
//  email address. Phone-only is 422 on create and on update (judged on
//  what the update leaves behind); on import, phone-only rows are refused
//  and listed with the same reason, and the rest of the file imports.
//  Each case also runs with sms ON, so the difference is the flag.
// ─────────────────────────────────────────

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  while (cleanup.length) {
    const fn = cleanup.shift();
    if (fn) await fn();
  }
});

const setup = async () => {
  const tenant = await createTestTenant();
  const organiser = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenant.id });
  const event = await createTestEvent(tenant.id, organiser.id);
  const day = await createTestEventDay(event.id, organiser.id);
  cleanup.push(
    async () => {
      const guests = await prisma.guest.findMany({ where: { eventId: event.id }, select: { id: true } });
      for (const g of guests) await deleteTestGuest(g.id);
    },
    async () => { await prisma.eventDay.deleteMany({ where: { eventId: event.id } }); },
    () => deleteTestEvent(event.id),
    () => deleteTestUserRow(organiser.id),
    () => deleteTestTenant(tenant.id)
  );
  const create = (contact: { email?: string; phoneNumber?: string }) =>
    guestService.create(event.id, organiser.id, 'TENANT_ADMIN', tenant.id, {
      firstName: 'Test', eventDayIds: [day.id], ...contact,
    });
  return { tenant, organiser, event, day, create };
};

const phone = () => `+2782${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;
const email = () => `sms-off-${randomUUID()}@test.invalid`;

describe('sms off — guest create', () => {
  it('flag on: a phone-only guest is created (the control)', async () => {
    const { create } = await setup();
    vi.stubEnv('FEATURES_DISABLED', '');
    const guest = await create({ phoneNumber: phone() });
    expect(guest.email).toBeNull();
  }, 60000);

  it('flag off: a phone-only guest is 422 with the email message; an email guest is created', async () => {
    const { create } = await setup();
    vi.stubEnv('FEATURES_DISABLED', 'sms');
    await expect(create({ phoneNumber: phone() })).rejects.toMatchObject({ statusCode: 422, message: GUEST_EMAIL_REQUIRED_MESSAGE });
    const guest = await create({ email: email() });
    expect(guest.email).toMatch(/@test\.invalid$/);
  }, 60000);
});

describe('sms off — guest update', () => {
  it('flag off: swapping an email guest to phone-only is 422 and nothing changes', async () => {
    const { tenant, create } = await setup();
    const guest = await create({ email: email() });

    vi.stubEnv('FEATURES_DISABLED', 'sms');
    await expect(
      guestService.update(guest.id, 'TENANT_ADMIN', tenant.id, { email: null, phoneNumber: phone() })
    ).rejects.toMatchObject({ statusCode: 422, message: GUEST_EMAIL_REQUIRED_MESSAGE });
    const after = await prisma.guest.findUniqueOrThrow({ where: { id: guest.id } });
    expect(after.email).toBe(guest.email);
    expect(after.phoneNumber).toBeNull();

    vi.stubEnv('FEATURES_DISABLED', '');
    const swapped = await guestService.update(guest.id, 'TENANT_ADMIN', tenant.id, { email: null, phoneNumber: phone() });
    expect(swapped.email).toBeNull();
  }, 60000);

  it('flag off: an existing phone-only guest is saved once an email replaces the phone', async () => {
    const { tenant, create } = await setup();
    vi.stubEnv('FEATURES_DISABLED', '');
    const guest = await create({ phoneNumber: phone() });

    vi.stubEnv('FEATURES_DISABLED', 'sms');
    await expect(
      guestService.update(guest.id, 'TENANT_ADMIN', tenant.id, { firstName: 'Renamed' })
    ).rejects.toMatchObject({ statusCode: 422, message: GUEST_EMAIL_REQUIRED_MESSAGE });
    const fixed = await guestService.update(guest.id, 'TENANT_ADMIN', tenant.id, { email: email(), phoneNumber: null });
    expect(fixed.email).toMatch(/@test\.invalid$/);
  }, 60000);
});

describe('sms off — guest import', () => {
  const importCsv = (ctx: Awaited<ReturnType<typeof setup>>, rows: string[]) =>
    guestService.importGuests(ctx.event.id, ctx.organiser.id, 'TENANT_ADMIN', ctx.tenant.id, {
      buffer: Buffer.from(['First,Surname,Contact,Day,Plus ones', ...rows].join('\n')),
      originalname: 'guests.csv',
      mimetype: 'text/csv',
    });

  it('flag off: phone rows are refused and listed with the reason; email rows import', async () => {
    const ctx = await setup();
    const phoneA = phone();
    const phoneB = phone();
    vi.stubEnv('FEATURES_DISABLED', 'sms');

    const result = await importCsv(ctx, [`Ann,One,${email()},,`, `Ben,Two,${phoneA},,`, `Cat,Three,${email()},,`, `Dan,Four,${phoneB},,`]);

    expect(result).toMatchObject({ totalRows: 4, created: 2, failed: 2 });
    expect(result.failures).toEqual([
      { row: 3, contact: phoneA, reason: GUEST_EMAIL_REQUIRED_MESSAGE },
      { row: 5, contact: phoneB, reason: GUEST_EMAIL_REQUIRED_MESSAGE },
    ]);
    const stored = await prisma.guest.findMany({ where: { eventId: ctx.event.id } });
    expect(stored.map((g) => g.firstName).sort()).toEqual(['Ann', 'Cat']);
  }, 60000);

  it('flag on: the same phone rows import (the control)', async () => {
    const ctx = await setup();
    vi.stubEnv('FEATURES_DISABLED', '');
    const result = await importCsv(ctx, [`Ann,One,${email()},,`, `Ben,Two,${phone()},,`]);
    expect(result).toMatchObject({ totalRows: 2, created: 2, failed: 0 });
  }, 60000);
});
