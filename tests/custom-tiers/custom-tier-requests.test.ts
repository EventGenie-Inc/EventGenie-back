import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { createTenant, createActor, installFirebaseMock, headersFor, deleteTenantsDeep, prisma, type Actor } from '../helpers/team.js';
import { sentEmails, clearSentEmails, failEmailsTo, acceptAllEmails } from '../helpers/sent-emails.js';
import { deleteCustomTierFixtures } from './custom-tier-fixtures.js';

// ─────────────────────────────────────────
//  REQUESTS FOR A CUSTOM TIER (STEERING "Custom tiers"; behind customTiers)
//
//  A tenant admin asks; the request is saved and emailed to
//  admin@e-velope.co.za (Reply-To: their contact), and listed for the super
//  admin, who moves its status and can reply with a note, emailed to the
//  contact.
// ─────────────────────────────────────────

const ADMIN_ADDRESS = 'admin@e-velope.co.za';
let tenantId: string;
let admin: Actor;
let member: Actor;
let superAdmin: Actor;

const body = {
  needs: '20 student societies on one discounted plan, invoiced to the university.',
  expectedEvents: 60,
  expectedGuests: 300,
  contactName: 'Thandi M',
  contactEmail: 'Thandi.M@University.example',
  contactPhone: '+27 82 000 0000',
};

beforeAll(async () => {
  const tenant = await createTenant('Wits Societies');
  tenantId = tenant.id;
  admin = await createActor('TENANT_ADMIN', tenantId);
  member = await createActor('EVENT_ADMIN', tenantId);
  superAdmin = await createActor('SUPER_ADMIN', null);
}, 60_000);

afterAll(async () => {
  await deleteCustomTierFixtures({ tenantIds: [tenantId] });
  await prisma.adminAuditEntry.deleteMany({ where: { actorUserId: superAdmin.id } });
  await deleteTenantsDeep([tenantId]);
  await prisma.termsAcceptance.deleteMany({ where: { userId: superAdmin.id } });
  await prisma.user.delete({ where: { id: superAdmin.id } });
}, 120_000);

beforeEach(() => {
  installFirebaseMock();
  clearSentEmails();
});
afterEach(() => {
  vi.unstubAllEnvs();
  acceptAllEmails();
});

describe('a tenant asks for a custom tier', () => {
  it('is saved, emailed to the admin address with the details, and listed for the super admin', async () => {
    const res = await request(app).post('/api/custom-tier-requests').set(headersFor(admin)).send(body);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      status: 'NEW',
      needs: body.needs,
      expectedEvents: 60,
      expectedGuests: 300,
      contactName: 'Thandi M',
      contactEmail: 'thandi.m@university.example',
      contactPhone: '+27820000000',
      adminNotified: true,
    });

    const mail = sentEmails().filter((m) => m.to === ADMIN_ADDRESS);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.subject).toBe('Custom plan request from Wits Societies');
    expect(mail[0]!.replyTo).toBe('thandi.m@university.example');
    expect(mail[0]!.text).toContain(body.needs);
    expect(mail[0]!.text).toContain('Events: 60');
    expect(mail[0]!.text).toContain('Guests: 300');

    const own = await request(app).get('/api/custom-tier-requests').set(headersFor(admin));
    expect(own.body.data.map((r: { id: string }) => r.id)).toContain(res.body.data.id);

    const list = await request(app).get('/api/admin/custom-tier-requests?status=NEW').set(headersFor(superAdmin));
    expect(list.status).toBe(200);
    expect(list.body.data.find((r: { id: string }) => r.id === res.body.data.id)).toMatchObject({ tenant: { id: tenantId, name: 'Wits Societies' } });
  });

  it('is still saved when the email fails, and says so', async () => {
    failEmailsTo([ADMIN_ADDRESS], 'refused');
    const res = await request(app).post('/api/custom-tier-requests').set(headersFor(admin)).send(body);
    expect(res.status).toBe(201);
    expect(res.body.data.adminNotified).toBe(false);
    expect(await prisma.customTierRequest.findUnique({ where: { id: res.body.data.id } })).not.toBeNull();
  });

  it('needs what they need, a contact name and an email we can reply to', async () => {
    for (const bad of [{ ...body, needs: '' }, { ...body, contactName: ' ' }, { ...body, contactEmail: 'nope' }, { ...body, expectedGuests: -3 }]) {
      const res = await request(app).post('/api/custom-tier-requests').set(headersFor(admin)).send(bad);
      expect(res.status).toBe(422);
    }
    expect(sentEmails()).toHaveLength(0);
  });

  it('is a tenant admin\'s (an event admin is refused) and 404 while customTiers is off', async () => {
    expect((await request(app).post('/api/custom-tier-requests').set(headersFor(member)).send(body)).status).toBe(403);
    vi.stubEnv('FEATURES_DISABLED', 'customTiers');
    expect((await request(app).post('/api/custom-tier-requests').set(headersFor(admin)).send(body)).status).toBe(404);
    // A flag never hides from a super admin (STEERING "Feature flags").
    expect((await request(app).get('/api/admin/custom-tier-requests').set(headersFor(superAdmin))).status).toBe(200);
  });
});

describe("the contact phone follows every other number's rules", () => {
  const ask = (extra: Record<string, unknown>) =>
    request(app).post('/api/custom-tier-requests').set(headersFor(admin)).send({ ...body, ...extra });

  it('a local number is read in South Africa by default, and saved in international form', async () => {
    const res = await ask({ contactPhone: '082 123 4567' });
    expect(res.status).toBe(201);
    expect(res.body.data.contactPhone).toBe('+27821234567');
  });

  it('a local number is read in the selected country (contactPhoneCountry)', async () => {
    const res = await ask({ contactPhone: '07911 123456', contactPhoneCountry: 'gb' });
    expect(res.status).toBe(201);
    expect(res.body.data.contactPhone).toBe('+447911123456');
  });

  it('a number with its own country code keeps it, whatever is selected; blank means none', async () => {
    expect((await ask({ contactPhone: '+44 7911 123456', contactPhoneCountry: 'ZA' })).body.data.contactPhone).toBe('+447911123456');
    expect((await ask({ contactPhone: '' })).body.data.contactPhone).toBeNull();
  });

  it('an invalid number is 422 CONTACT_PHONE_INVALID; an unknown country 422 CONTACT_PHONE_COUNTRY_INVALID; nothing saved or sent', async () => {
    const before = await prisma.customTierRequest.count({ where: { tenantId } });
    for (const phone of ['12345', '082 123', '(082) abc defg', 42]) {
      const res = await ask({ contactPhone: phone });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('CONTACT_PHONE_INVALID');
    }
    const country = await ask({ contactPhone: '082 123 4567', contactPhoneCountry: 'XX' });
    expect(country.status).toBe(422);
    expect(country.body.code).toBe('CONTACT_PHONE_COUNTRY_INVALID');
    expect(await prisma.customTierRequest.count({ where: { tenantId } })).toBe(before);
    expect(sentEmails()).toHaveLength(0);
  });
});

describe('the super admin answers', () => {
  it('moves the status, replies with a note emailed to the contact, and the tenant sees both', async () => {
    const created = await request(app).post('/api/custom-tier-requests').set(headersFor(admin)).send(body);
    clearSentEmails();
    const id = created.body.data.id as string;

    const res = await request(app)
      .patch(`/api/admin/custom-tier-requests/${id}`)
      .set(headersFor(superAdmin))
      .send({ status: 'IN_DISCUSSION', note: 'Thanks, we can do this. I\'ll call you on Monday.' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'IN_DISCUSSION', adminNote: 'Thanks, we can do this. I\'ll call you on Monday.', noteEmailed: true });

    const mail = sentEmails().filter((m) => m.to === 'thandi.m@university.example');
    expect(mail).toHaveLength(1);
    expect(mail[0]!.text).toContain("I'll call you on Monday.");
    expect(mail[0]!.replyTo).toBe(ADMIN_ADDRESS);

    const own = await request(app).get('/api/custom-tier-requests').set(headersFor(admin));
    expect(own.body.data.find((r: { id: string }) => r.id === id)).toMatchObject({ status: 'IN_DISCUSSION', adminNote: expect.any(String) });

    const status = await request(app).patch(`/api/admin/custom-tier-requests/${id}`).set(headersFor(superAdmin)).send({ status: 'ACCEPTED' });
    expect(status.body.data).toMatchObject({ status: 'ACCEPTED', noteEmailed: null });

    const bad = await request(app).patch(`/api/admin/custom-tier-requests/${id}`).set(headersFor(superAdmin)).send({ status: 'MAYBE' });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('CUSTOM_TIER_REQUEST_STATUS_INVALID');

    const tenantTry = await request(app).patch(`/api/admin/custom-tier-requests/${id}`).set(headersFor(admin)).send({ status: 'DECLINED' });
    expect(tenantTry.status).toBe(404);
  });
});
