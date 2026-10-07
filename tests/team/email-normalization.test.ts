import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import app from '../../src/app.js';
import { userRepository } from '../../src/modules/user/user.repository.js';
import { findDuplicateContact } from '../../src/modules/guest/guest-validation.util.js';
import {
  createTenant,
  createActor,
  installFirebaseMock,
  headersFor,
  createEventWithDay,
  deleteTenantsDeep,
  prisma,
  type Actor,
} from '../helpers/team.js';

// ─────────────────────────────────────────
//  Emails are stored and compared lowercase and trimmed (Team Members
//  batch): POST /api/users, the database's own unique-email error mapped to
//  409 USER_EMAIL_TAKEN (never a 500), guest duplicate checks, and the
//  20261006091000_lowercase_emails data migration (collisions skipped).
// ─────────────────────────────────────────

let tenantId: string;
let admin: Actor;

beforeAll(async () => {
  tenantId = (await createTenant()).id;
  admin = await createActor('TENANT_ADMIN', tenantId);
}, 60000);

afterAll(async () => {
  await deleteTenantsDeep([tenantId]);
}, 120000);

beforeEach(() => {
  installFirebaseMock();
});

const createUser = (email: string) => {
  const suffix = randomUUID();
  return request(app)
    .post('/api/users')
    .set(headersFor(admin))
    .send({ firebaseUid: `norm-${suffix}`, email, username: `norm-${suffix}`, role: 'EVENT_ADMIN' });
};

describe('POST /api/users', () => {
  it('stores the email lowercased and trimmed; the same address in another case is 409 USER_EMAIL_TAKEN', async () => {
    const local = `Mixed.Case-${randomUUID().slice(0, 8)}`;
    const first = await createUser(`  ${local}@Example.TEST `);
    expect(first.status).toBe(201);
    expect(first.body.data.email).toBe(`${local.toLowerCase()}@example.test`);

    const second = await createUser(`${local.toLowerCase()}@example.test`);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('USER_EMAIL_TAKEN');
  }, 60000);

  it("two creations racing past the pre-check: the database's unique error is the same 409, not a 500", async () => {
    const email = `race-${randomUUID().slice(0, 8)}@test.invalid`;
    expect((await createUser(email)).status).toBe(201);

    // The second request's pre-check runs before the first one committed.
    vi.spyOn(userRepository, 'findByEmail').mockResolvedValueOnce(null);
    const raced = await createUser(email.toUpperCase());
    vi.restoreAllMocks();
    expect(raced.status).toBe(409);
    expect(raced.body).toEqual({
      status: 'error',
      message: 'A user with this email address already exists. Use a different email address.',
      code: 'USER_EMAIL_TAKEN',
    });
  }, 60000);
});

describe('guest duplicate detection', () => {
  it('matches an email whatever its stored case', () => {
    expect(findDuplicateContact([{ guestId: 'g1', email: 'Thandi@Example.com', phoneNumber: null }], { email: 'thandi@example.com', phoneNumber: null }))
      .toEqual({ guestId: 'g1' });
  });
});

describe('the lowercase_emails migration', () => {
  it('lowercases and trims user and guest emails, and skips every row that would collide', async () => {
    const tag = randomUUID().slice(0, 8);
    const { event } = await createEventWithDay(tenantId, admin.id);
    const { event: otherEvent } = await createEventWithDay(tenantId, admin.id);
    const mkUser = (email: string) =>
      prisma.user.create({ data: { firebaseUid: `mig-${randomUUID()}`, email, username: 'mig', role: 'EVENT_ADMIN', tenantId } });
    const mkGuest = (eventId: string, email: string) => prisma.guest.create({ data: { eventId, email } });

    const plain = await mkUser(` Plain-${tag}@X.TEST `);
    const dupUpper = await mkUser(`Dup-${tag}@x.test`);
    const dupLower = await mkUser(`dup-${tag}@x.test`);
    const guestPlain = await mkGuest(event.id, `Guest-${tag}@X.test`);
    const guestDupA = await mkGuest(event.id, `Same-${tag}@x.test`);
    const guestDupB = await mkGuest(event.id, `SAME-${tag}@x.test`);
    // The same address on a DIFFERENT event is not a collision.
    const guestOtherEvent = await mkGuest(otherEvent.id, `SAME-${tag}@X.TEST`);

    const sql = readFileSync('prisma/migrations/20261006091000_lowercase_emails/migration.sql', 'utf8');
    const statements = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements).toHaveLength(2);
    for (const statement of statements) await prisma.$executeRawUnsafe(statement);

    const email = async (model: 'user' | 'guest', id: string) =>
      model === 'user'
        ? (await prisma.user.findUniqueOrThrow({ where: { id } })).email
        : (await prisma.guest.findUniqueOrThrow({ where: { id } })).email;

    expect(await email('user', plain.id)).toBe(`plain-${tag}@x.test`);
    expect(await email('user', dupUpper.id)).toBe(`Dup-${tag}@x.test`);
    expect(await email('user', dupLower.id)).toBe(`dup-${tag}@x.test`);
    expect(await email('guest', guestPlain.id)).toBe(`guest-${tag}@x.test`);
    expect(await email('guest', guestDupA.id)).toBe(`Same-${tag}@x.test`);
    expect(await email('guest', guestDupB.id)).toBe(`SAME-${tag}@x.test`);
    expect(await email('guest', guestOtherEvent.id)).toBe(`same-${tag}@x.test`);
  }, 90000);
});
