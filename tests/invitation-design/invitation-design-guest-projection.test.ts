import { describe, it, expect, afterEach } from 'vitest';
import { rsvpService } from '../../src/modules/rsvp/rsvp.service.js';
import {
  createTestTenant,
  deleteTestTenant,
  createTestUserRow,
  deleteTestUserRow,
  createTestEvent,
  deleteTestEvent,
  createTestEventDay,
  createTestGuestWithInvite,
  deleteTestGuest,
  prisma,
} from '../helpers/fixtures.js';

// ─────────────────────────────────────────
//  INVITATION DESIGNS (V1) — guest projection on GET /api/rsvp/validate
//
//  `design` must be an explicit allowlist: exact key sets, so a column
//  added to InvitationDesign later cannot start reaching guests unnoticed.
//  Also asserts the invitation's other data (venue coordinates) is present.
// ─────────────────────────────────────────

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
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
  const { guest, invite } = await createTestGuestWithInvite(event.id, organiser.id, [day.id]);
  cleanup.push(
    () => deleteTestGuest(guest.id),
    async () => { await prisma.invitationDesign.deleteMany({ where: { eventId: event.id } }); },
    async () => { await prisma.eventDay.deleteMany({ where: { eventId: event.id } }); },
    () => deleteTestEvent(event.id),
    () => deleteTestUserRow(organiser.id),
    () => deleteTestTenant(tenant.id)
  );
  return { tenant, organiser, event, invite };
};

const INTERNAL_FIELDS = ['id', 'eventId', 'cloudinaryPublicId', 'createdBy', 'updatedBy', 'createdAt', 'updatedAt', 'isArchived'];

describe('rsvp validate() — invitation design projection', () => {
  it('design is null when the event has none', async () => {
    const { invite } = await setup();
    const result = await rsvpService.validate(invite.token);
    expect(result.design).toBeNull();
  }, 30000);

  it('TEMPLATE: exactly kind, templateId, templateVersion, overrides', async () => {
    const { event, organiser, invite } = await setup();
    const overrides = { elements: { 'host-names': { color: '#1f2937', text: 'Sarah & Tom' } } };
    await prisma.invitationDesign.create({
      data: { eventId: event.id, kind: 'TEMPLATE', templateId: 'wedding', templateVersion: 3, overrides, createdBy: organiser.id, updatedBy: organiser.id },
    });

    const { design } = await rsvpService.validate(invite.token);
    expect(Object.keys(design ?? {}).sort()).toEqual(['kind', 'overrides', 'templateId', 'templateVersion']);
    expect(design).toEqual({ kind: 'TEMPLATE', templateId: 'wedding', templateVersion: 3, overrides });
    for (const f of INTERNAL_FIELDS) expect(design).not.toHaveProperty(f);
  }, 30000);

  it('UPLOAD: exactly kind, imageUrl, width, height, altText (no publicId)', async () => {
    const { event, organiser, invite } = await setup();
    await prisma.invitationDesign.create({
      data: {
        eventId: event.id, kind: 'UPLOAD',
        imageUrl: 'https://res.cloudinary.com/demo/image/upload/v1/eventgenie/t/invitation-designs/e/x.png',
        cloudinaryPublicId: 'eventgenie/t/invitation-designs/e/x',
        width: 1080, height: 1350, altText: null,
        createdBy: organiser.id, updatedBy: organiser.id,
      },
    });

    const { design } = await rsvpService.validate(invite.token);
    expect(Object.keys(design ?? {}).sort()).toEqual(['altText', 'height', 'imageUrl', 'kind', 'width']);
    for (const f of INTERNAL_FIELDS) expect(design).not.toHaveProperty(f);
    expect(JSON.stringify(design)).not.toContain('"eventgenie/t/invitation-designs/e/x"');
  }, 30000);

  it('an archived design is not shown to guests', async () => {
    const { event, organiser, invite } = await setup();
    await prisma.invitationDesign.create({
      data: { eventId: event.id, kind: 'TEMPLATE', templateId: 'wedding', templateVersion: 1, overrides: { elements: {} }, isArchived: true, createdBy: organiser.id, updatedBy: organiser.id },
    });
    expect((await rsvpService.validate(invite.token)).design).toBeNull();
  }, 30000);

  it('event carries venue coordinates as plain numbers (or null)', async () => {
    const { event, invite } = await setup();
    expect((await rsvpService.validate(invite.token)).invite.event).toMatchObject({ latitude: null, longitude: null });

    await prisma.event.update({ where: { id: event.id }, data: { latitude: -26.1943201, longitude: 28.0340512 } });
    const withCoords = (await rsvpService.validate(invite.token)).invite.event;
    expect(withCoords.latitude).toBe(-26.1943201);
    expect(withCoords.longitude).toBe(28.0340512);
  }, 30000);
});
