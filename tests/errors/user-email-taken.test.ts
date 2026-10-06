import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import app from '../../src/app.js';
import { mockVerifyIdToken } from '../setup.js';
import { createTestTenant, deleteTestTenant, createTestUserRow, deleteTestUserRow, prisma } from '../helpers/fixtures.js';

// ─────────────────────────────────────────
//  POST /api/users with an email that already has an account: 409 with
//  code USER_EMAIL_TAKEN and a message the admin can act on. It used to
//  throw a bare Error, which the global handler turns into a generic 500.
// ─────────────────────────────────────────

let tenantId: string;
let admin: { id: string; firebaseUid: string; email: string };
const createdIds: string[] = [];

const headers = () => {
  const firebaseToken = `email-taken-${admin.id}`;
  const session = jwt.sign(
    { userId: admin.id, firebaseUid: admin.firebaseUid, email: admin.email, role: 'TENANT_ADMIN', tenantId },
    process.env.JWT_SECRET as string,
    { expiresIn: '15m' }
  );
  return { Authorization: `Bearer ${firebaseToken}`, 'X-Session-Token': session };
};

beforeAll(async () => {
  tenantId = (await createTestTenant()).id;
  admin = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId });
}, 60000);

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdIds } } });
  await deleteTestUserRow(admin.id);
  await deleteTestTenant(tenantId);
}, 60000);

beforeEach(() => {
  mockVerifyIdToken.mockImplementation(async () => ({ uid: admin.firebaseUid }));
});

const body = (email: string) => {
  const suffix = randomUUID();
  return { firebaseUid: `email-taken-${suffix}`, email, username: `email-taken-${suffix}`, role: 'EVENT_ADMIN' };
};

describe('POST /api/users — duplicate email', () => {
  it('a new email is created (the control); the same email again is 409 USER_EMAIL_TAKEN', async () => {
    const email = `email-taken-${randomUUID()}@test.invalid`;

    const first = await request(app).post('/api/users').set(headers()).send(body(email));
    expect(first.status).toBe(201);
    createdIds.push(first.body.data.id);

    const second = await request(app).post('/api/users').set(headers()).send(body(email));
    expect(second.status).toBe(409);
    expect(second.body).toEqual({
      status: 'error',
      message: 'A user with this email address already exists. Use a different email address.',
      code: 'USER_EMAIL_TAKEN',
    });
    expect(await prisma.user.count({ where: { email } })).toBe(1);
  }, 60000);
});
