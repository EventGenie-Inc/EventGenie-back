import { randomUUID } from 'crypto';
import request from 'supertest';
import app from '../../src/app.js';
import prisma from '../../src/shared/prisma/prisma.client.js';
import { createTenant, createActor, createEventWithDay, deleteTenantsDeep, type Actor } from '../helpers/team.js';

// ─────────────────────────────────────────
//  Public events fixtures: a tenant with an organiser and one PUBLISHED,
//  PUBLIC event with a share token and one day (more on request). Every
//  registration request gets its own client IP (X-Forwarded-For; the app
//  trusts one proxy hop) and, unless given, its own email, so the per-IP
//  and per-email limiters never interfere with tests that aren't about them.
// ─────────────────────────────────────────

const tenantIds: string[] = [];

export const cleanupPublicEventFixtures = async () => {
  if (tenantIds.length) await deleteTenantsDeep(tenantIds.splice(0));
};

let ipCounter = 0;
export const freshIp = () => {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
};

export const freshEmail = (domain = 'test.invalid') => `reg-${randomUUID()}@${domain}`;

export interface PublicEventFixture {
  tenantId: string;
  organiser: Actor;
  eventId: string;
  shareToken: string;
  dayIds: string[];
}

export const createPublicEvent = async (
  opts: { days?: number; event?: Record<string, unknown> } = {}
): Promise<PublicEventFixture> => {
  const tenant = await createTenant();
  tenantIds.push(tenant.id);
  const organiser = await createActor('TENANT_ADMIN', tenant.id);
  const { event, day } = await createEventWithDay(tenant.id, organiser.id, `Year-end function ${randomUUID()}`);
  const shareToken = `pub-${randomUUID()}`;
  await prisma.event.update({
    where: { id: event.id },
    data: { visibility: 'PUBLIC', shareToken, hostName: 'Acme HR', ...(opts.event ?? {}) },
  });
  const dayIds = [day.id];
  for (let i = 2; i <= (opts.days ?? 1); i++) {
    const extra = await prisma.eventDay.create({
      data: {
        eventId: event.id,
        label: `Day ${i}`,
        date: new Date(`2027-03-0${i}`),
        location: `Venue ${i}`,
        address: `${i} Test Road, Cape Town`,
        createdBy: organiser.id,
        updatedBy: organiser.id,
      },
    });
    dayIds.push(extra.id);
  }
  return { tenantId: tenant.id, organiser, eventId: event.id, shareToken, dayIds };
};

export const register = (shareToken: string, body: Record<string, unknown>, ip = freshIp()) =>
  request(app)
    .post(`/api/public-events/${shareToken}/register`)
    .set('X-Forwarded-For', ip)
    .send({ firstName: 'Thandi', email: freshEmail(), ...body });

export const view = (shareToken: string, ip = freshIp()) =>
  request(app).get(`/api/public-events/${shareToken}`).set('X-Forwarded-For', ip);

export { prisma };
