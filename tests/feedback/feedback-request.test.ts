import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { assign, createActor, createTenant, prisma, type Actor } from '../helpers/team.js';
import { clearSentEmails, sentEmails } from '../helpers/sent-emails.js';
import { feedbackRequestService } from '../../src/modules/feedback/feedback-request.service.js';
import { EMAIL_LAYOUT_MARKER } from '../../src/shared/messaging/email-layout.js';
import { cleanupTenants, newEvent } from './helpers.js';

// ─────────────────────────────────────────
//  "HOW DID <EVENT> GO?" — the feedback request sweep
//
//  From 08:00 UTC the day after an event's last day (here: events whose
//  last day was two days ago, always due), its organisers are emailed once.
//  The claim row (unique per event) is taken before sending, so two sweeps
//  racing, or the same event requested twice at once, email once; a later
//  sweep sends nothing. Never for a cancelled, draft or future event, one
//  with feedback, one too old to ask about, or with `feedback` off.
// ─────────────────────────────────────────

vi.setConfig({ testTimeout: 120_000 });

const BASE = 'https://app.example.test';
const tenantIds: string[] = [];
let tenantId: string;
let tenantAdmin: Actor;

beforeAll(async () => {
  const tenant = await createTenant();
  tenantIds.push(tenant.id);
  tenantId = tenant.id;
  tenantAdmin = await createActor('TENANT_ADMIN', tenant.id);
}, 60000);

beforeEach(() => {
  vi.stubEnv('FRONTEND_BASE_URL', BASE);
  clearSentEmails();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await cleanupTenants(tenantIds.splice(0));
}, 120000);

const link = (eventId: string) => `${BASE}/events/${eventId}/feedback`;
const emailsFor = (eventId: string) => sentEmails().filter((e) => e.text.includes(link(eventId)));

describe('who is asked, and the email', () => {
  it("the event's creator and its assigned members, once, through the shared layout with one button to the feedback page", async () => {
    const creator = await createActor('TENANT_ADMIN', tenantId);
    const member = await createActor('EVENT_ADMIN', tenantId);
    const { event } = await newEvent(tenantId, creator.id, { daysAgo: 2, name: 'Year-end <b>function</b>' });
    await assign(tenantId, member.id, event.id, creator.id);

    await feedbackRequestService.sweep();
    const emails = emailsFor(event.id);
    expect(emails.map((e) => e.to).sort()).toEqual([creator.email, member.email].sort());
    // Not everyone in the tenant: the other admin didn't organise it.
    expect(emails.map((e) => e.to)).not.toContain(tenantAdmin.email);

    const [email] = emails;
    // A header: angle brackets dropped (email-address.util.ts), like every
    // organiser-typed subject.
    expect(email!.subject).toBe('How did Year-end bfunction/b go?');
    expect(email!.from).toMatch(/^"e-velope" </);
    expect(email!.html).toContain(EMAIL_LAYOUT_MARKER);
    expect(email!.html).toContain('Year-end &lt;b&gt;function&lt;/b&gt;');
    expect(email!.html).not.toContain('<b>function</b>');
    expect(email!.html).toContain(`href="${link(event.id)}"`);
    expect(email!.text).toContain('Share your feedback');
    expect(email!.text).toContain(link(event.id));

    expect(await prisma.feedbackRequestClaim.findUnique({ where: { eventId: event.id } })).toMatchObject({ recipientCount: 2 });
  });

  it("a locked creator not assigned to the event isn't asked; with no organiser left, the tenant admins are", async () => {
    const locked = await createActor('EVENT_ADMIN', tenantId);
    const elsewhere = await newEvent(tenantId, locked.id, { daysAgo: -60 });
    await assign(tenantId, locked.id, elsewhere.event.id, locked.id);
    const { event } = await newEvent(tenantId, locked.id, { daysAgo: 2 });

    await feedbackRequestService.sweep();
    const to = emailsFor(event.id).map((e) => e.to);
    expect(to).not.toContain(locked.email);
    expect(to).toContain(tenantAdmin.email);
  });
});

describe('once per event', () => {
  it('a second sweep sends nothing more', async () => {
    const { event } = await newEvent(tenantId, tenantAdmin.id, { daysAgo: 2 });
    await feedbackRequestService.sweep();
    expect(emailsFor(event.id)).toHaveLength(1);
    await feedbackRequestService.sweep();
    expect(emailsFor(event.id)).toHaveLength(1);
  });

  it('two sweeps racing email it once, with one claim', async () => {
    const { event } = await newEvent(tenantId, tenantAdmin.id, { daysAgo: 2 });
    await Promise.all([feedbackRequestService.sweep(), feedbackRequestService.sweep()]);
    expect(emailsFor(event.id)).toHaveLength(1);
    expect(await prisma.feedbackRequestClaim.count({ where: { eventId: event.id } })).toBe(1);
  });

  it('the same event requested twice at the same moment is emailed once', async () => {
    const { event } = await newEvent(tenantId, tenantAdmin.id, { daysAgo: 2 });
    const outcomes = await Promise.all([feedbackRequestService.requestFor(event.id), feedbackRequestService.requestFor(event.id)]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(emailsFor(event.id)).toHaveLength(1);
  });
});

describe('who is never asked', () => {
  it('a cancelled, draft or future event, one with feedback already, one ended too long ago, or an archived one', async () => {
    const cancelled = await newEvent(tenantId, tenantAdmin.id, { daysAgo: 2, status: 'CANCELLED' });
    const draft = await newEvent(tenantId, tenantAdmin.id, { daysAgo: 2, status: 'DRAFT' });
    const future = await newEvent(tenantId, tenantAdmin.id, { daysAgo: -2 });
    const tooOld = await newEvent(tenantId, tenantAdmin.id, { daysAgo: 30 });
    const archived = await newEvent(tenantId, tenantAdmin.id, { daysAgo: 2 });
    await prisma.event.update({ where: { id: archived.event.id }, data: { isArchived: true } });
    const answered = await newEvent(tenantId, tenantAdmin.id, { daysAgo: 2 });
    await prisma.eventFeedback.create({
      data: { eventId: answered.event.id, tenantId, score: 9, submittedBy: tenantAdmin.id, updatedBy: tenantAdmin.id },
    });

    await feedbackRequestService.sweep();
    for (const ev of [cancelled, draft, future, tooOld, archived, answered]) {
      expect(emailsFor(ev.event.id)).toEqual([]);
      expect(await prisma.feedbackRequestClaim.count({ where: { eventId: ev.event.id } })).toBe(0);
    }
  });

  it('nothing at all while `feedback` is off; the event is still asked once it is back on', async () => {
    const { event } = await newEvent(tenantId, tenantAdmin.id, { daysAgo: 2, name: `Flag ${randomUUID()}` });
    vi.stubEnv('FEATURES_DISABLED', 'feedback');
    expect(await feedbackRequestService.sweep()).toEqual([]);
    expect(emailsFor(event.id)).toEqual([]);
    expect(await prisma.feedbackRequestClaim.count({ where: { eventId: event.id } })).toBe(0);

    vi.stubEnv('FEATURES_DISABLED', '');
    await feedbackRequestService.sweep();
    expect(emailsFor(event.id)).toHaveLength(1);
  });
});
