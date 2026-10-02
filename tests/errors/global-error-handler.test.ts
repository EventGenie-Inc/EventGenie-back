import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import app, { GENERIC_ERROR_MESSAGE } from '../../src/app.js';
import { inviteRepository } from '../../src/modules/invite/invite.repository.js';
import { prisma } from '../helpers/fixtures.js';

// ─────────────────────────────────────────
//  GLOBAL ERROR HANDLER — no raw error text reaches a client
//
//  The handler used to send err.message for any non-HttpError unless
//  NODE_ENV was 'production', so dev, test and any environment with
//  NODE_ENV unset returned raw Prisma text (model names, arguments,
//  SQL, table names). Real Prisma errors are produced here by a real
//  failing query behind a real public route (GET /api/rsvp/validate/:token
//  calls inviteRepository.findByToken), and the response must carry only
//  the generic message, while the full error is still logged server-side.
// ─────────────────────────────────────────

afterEach(() => {
  vi.restoreAllMocks();
});

const expectGeneric500 = (res: request.Response, leakedText: string) => {
  expect(res.status).toBe(500);
  expect(res.body).toEqual({ status: 'error', message: GENERIC_ERROR_MESSAGE });
  const raw = JSON.stringify(res.body);
  expect(raw).not.toContain(leakedText);
  expect(raw).not.toMatch(/prisma|invocation|findUnique|queryRaw|relation|SELECT/i);
};

describe('global error handler', () => {
  it("a Prisma validation error's text never reaches the response, and is logged", async () => {
    let prismaMessage = '';
    vi.spyOn(inviteRepository, 'findByToken').mockImplementationOnce(async () => {
      try {
        // A genuinely invalid query: Prisma rejects it with a
        // PrismaClientValidationError naming the model and arguments.
        return await prisma.invite.findUnique({ where: {} } as never);
      } catch (err) {
        prismaMessage = (err as Error).message;
        throw err;
      }
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app).get('/api/rsvp/validate/any-token');

    expect(prismaMessage.length).toBeGreaterThan(0);
    expectGeneric500(res, prismaMessage.slice(0, 40));
    // Server-side log still carries the real error.
    expect(logged.mock.calls.some((call) => call.some((arg) => arg instanceof Error && arg.message === prismaMessage))).toBe(true);
  }, 30000);

  it("a Prisma known-request error (raw SQL on a missing table) never reaches the response", async () => {
    let prismaMessage = '';
    vi.spyOn(inviteRepository, 'findByToken').mockImplementationOnce(async () => {
      try {
        await prisma.$queryRawUnsafe('SELECT * FROM "NoSuchTable_ErrorHandlerTest"');
        return null;
      } catch (err) {
        prismaMessage = (err as Error).message;
        throw err;
      }
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app).get('/api/rsvp/validate/any-token');

    expect(prismaMessage).toContain('NoSuchTable_ErrorHandlerTest');
    expectGeneric500(res, 'NoSuchTable_ErrorHandlerTest');
  }, 30000);

  it('control: an HttpError keeps its own status and message, unchanged', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).get('/api/rsvp/validate/definitely-not-a-real-token');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      status: 'error',
      message: "This invitation link isn't valid. Check the link in your message, or ask the organiser to resend it.",
    });
  }, 30000);
});
