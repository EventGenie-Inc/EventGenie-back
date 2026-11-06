import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes, createHash } from 'crypto';
import request from 'supertest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

// ─────────────────────────────────────────
//  DOCUMENT FIELDS (e.g. a proof of payment)
//
//  A guest uploads a file for a DOCUMENT question with their invitation
//  token, or on a public event's registration page; the upload's id is
//  the answer. The bytes decide the type, 5 MB at most, stored privately;
//  an organiser views it through a 5-minute signed link; the file is
//  deleted when replaced, when its event is deleted, by the archived-event
//  purge, and when never attached within 24 hours, always by the storage
//  worker (Round B: one deletion path). Removing a guest keeps their files
//  (tests/storage-retention/ has what happens at the event's finish).
//  Behind documentFields.
//
//  Cloudinary's private upload is mocked; deletes reach the fake Cloudinary
//  (tests/helpers/fake-cloudinary.ts) through the worker's single destroy,
//  so nothing real is stored or deleted; the signed link is built for real
//  (it makes no call) against test credentials.
// ─────────────────────────────────────────

const { mockUpload } = vi.hoisted(() => ({ mockUpload: vi.fn() }));
vi.mock('../../src/shared/cloudinary/cloudinary-private-asset.util.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/shared/cloudinary/cloudinary-private-asset.util.js')>()),
  uploadPrivateRawAsset: mockUpload,
}));

import app from '../../src/app.js';
import { createActor, createTenant, createEventWithDay, deleteTenantsDeep, headersFor, installFirebaseMock, assign, prisma, type Actor } from '../helpers/team.js';
import { guestRepository } from '../../src/modules/guest/guest.repository.js';
import { guestDocumentService } from '../../src/modules/guest-document/guest-document.service.js';
import { mediaRetentionService } from '../../src/modules/media-retention/media-retention.service.js';
import { memoryHubRepository } from '../../src/modules/memory-hub/memory-hub.repository.js';
import { guestDocumentRepository } from '../../src/modules/guest-document/guest-document.repository.js';
import { storageDeletionWorker } from '../../src/modules/storage/storage-deletion.worker.js';
import { fakeCloudinary } from '../helpers/fake-cloudinary.js';
import { guestDocumentFolder } from '../../src/modules/upload/upload-folders.js';
import { ROUTE_NOT_FOUND_BODY } from '../../src/shared/middleware/feature.middleware.js';
import { scrubValue, scrubText } from '../../src/shared/monitoring/sentry-scrub.js';

vi.setConfig({ testTimeout: 120_000 });

const DAY_MS = 24 * 60 * 60 * 1000;
const CLOUD = 'test-cloud';
const API_SECRET = 'test-secret';

const tenantIds: string[] = [];
let tenantId: string;
let organiser: Actor;
let lockedMember: Actor;
let vendor: Actor;
let outsider: Actor;

beforeAll(async () => {
  const tenant = await createTenant();
  tenantIds.push(tenant.id);
  tenantId = tenant.id;
  organiser = await createActor('TENANT_ADMIN', tenant.id);
  lockedMember = await createActor('EVENT_ADMIN', tenant.id);
  vendor = await createActor('EVENT_VENDOR', tenant.id);
  const other = await createTenant();
  tenantIds.push(other.id);
  outsider = await createActor('TENANT_ADMIN', other.id);
}, 60_000);

beforeEach(() => {
  installFirebaseMock();
  vi.stubEnv('CLOUDINARY_CLOUD_NAME', CLOUD);
  vi.stubEnv('CLOUDINARY_API_KEY', 'test-key');
  vi.stubEnv('CLOUDINARY_API_SECRET', API_SECRET);
  mockUpload.mockReset();
  mockUpload.mockImplementation(async (publicId: string, file: Buffer) => ({ ok: true, publicId, bytes: file.length }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await deleteTenantsDeep(tenantIds.splice(0));
}, 120_000);

// ── Fixtures ──────────────────────────────

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\n'), randomBytes(200), Buffer.from('\n%%EOF\n')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(200)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(200)]);
const CSV = Buffer.from('date,reference,amount\n2026-11-01,CHESS-42,150.00\n');
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.from([0x90, 0x00, 0x03, 0x00]), randomBytes(200)]);

const xlsxBuffer = async (): Promise<Buffer> => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Payment').addRow(['Reference', 'Amount']);
  return Buffer.from(await workbook.xlsx.writeBuffer());
};

// A real workbook turned into a macro workbook: the VBA project added and
// the main part's type changed, exactly what Excel writes for an .xlsm.
const xlsmBuffer = async (): Promise<Buffer> => {
  const zip = await JSZip.loadAsync(await xlsxBuffer());
  zip.file('xl/vbaProject.bin', randomBytes(512));
  const types = await zip.file('[Content_Types].xml')!.async('string');
  zip.file(
    '[Content_Types].xml',
    types.replace(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
      'application/vnd.ms-excel.sheet.macroEnabled.main+xml'
    )
  );
  return zip.generateAsync({ type: 'nodebuffer' });
};

interface Setup {
  eventId: string;
  dayId: string;
  fieldId: string;
  folder: string;
}

// A published private event with a required DOCUMENT question.
const newEvent = async (opts: { required?: boolean; visibility?: 'PUBLIC' | 'PRIVATE' } = {}): Promise<Setup & { shareToken: string | null }> => {
  const { event, day } = await createEventWithDay(tenantId, organiser.id);
  const shareToken = opts.visibility === 'PUBLIC' ? randomBytes(32).toString('hex') : null;
  if (shareToken) await prisma.event.update({ where: { id: event.id }, data: { visibility: 'PUBLIC', shareToken } });
  const field = await prisma.rsvpField.create({
    data: {
      eventId: event.id,
      label: 'Proof of payment',
      description: 'Pay R150 to the club, then upload the proof.',
      fieldType: 'DOCUMENT',
      isRequired: opts.required ?? true,
      order: 0,
      createdBy: organiser.id,
      updatedBy: organiser.id,
    },
  });
  return { eventId: event.id, dayId: day.id, fieldId: field.id, folder: guestDocumentFolder(tenantId, event.id), shareToken };
};

const newGuest = async (setup: Setup) => {
  const { guest, invite } = await guestRepository.createWithInvite(setup.eventId, organiser.id, {
    firstName: 'Thandi',
    surname: 'Nkosi',
    email: `guest-${randomBytes(6).toString('hex')}@test.invalid`,
    phoneNumber: null,
    eventDayIds: [setup.dayId],
    plusOnesAllowed: 0,
  });
  return { guestId: guest.id, inviteId: invite.id, token: invite.token };
};

const uploadAsGuest = (token: string, fieldId: string, file: Buffer, name: string) =>
  request(app).post('/api/rsvp/documents').field('token', token).field('rsvpFieldId', fieldId).attach('file', file, name);

const uploadAsRegistrant = (shareToken: string, fieldId: string, file: Buffer, name: string) =>
  request(app).post(`/api/public-events/${shareToken}/documents`).field('rsvpFieldId', fieldId).attach('file', file, name);

const submit = (token: string, setup: Setup, documentId: string | null, attending = true) =>
  request(app)
    .post('/api/rsvp/submit')
    .send({
      token,
      attending,
      attendingDayIds: attending ? [setup.dayId] : [],
      rsvpResponses: documentId ? [{ rsvpFieldId: setup.fieldId, value: documentId }] : [],
    });

// An uploaded and submitted document, ready for the organiser.
const receivedDocument = async (setup: Setup) => {
  const guest = await newGuest(setup);
  const upload = await uploadAsGuest(guest.token, setup.fieldId, PDF, 'Proof of payment (Thandi).pdf');
  expect(upload.status).toBe(201);
  const res = await submit(guest.token, setup, upload.body.data.id);
  expect(res.status).toBe(200);
  return { ...guest, documentId: upload.body.data.id as string };
};

const documentRow = (id: string) => prisma.guestDocument.findUniqueOrThrow({ where: { id } });

// What the storage worker asked Cloudinary to destroy, of this event's documents.
const destroyedIds = (): string[] => fakeCloudinary.destroyedIds().filter((id) => id.includes('/document/'));
// Each destroy is of a private raw file.
const destroyCallFor = (publicId: string) => fakeCloudinary.callsTo('destroy').find((c) => c.publicIds[0] === publicId)!;

// ── Uploading ─────────────────────────────

describe('uploading with an invitation', () => {
  it('stores a PDF privately in the event documents folder and returns the document', async () => {
    const setup = await newEvent();
    const guest = await newGuest(setup);

    const res = await uploadAsGuest(guest.token, setup.fieldId, PDF, 'Proof of payment (Thandi).pdf');

    expect(res.status).toBe(201);
    expect(Object.keys(res.body.data).sort()).toEqual(['contentType', 'fileName', 'id', 'rsvpFieldId', 'sizeBytes', 'uploadedAt']);
    expect(res.body.data).toMatchObject({
      rsvpFieldId: setup.fieldId,
      fileName: 'Proof of payment (Thandi).pdf',
      contentType: 'application/pdf',
      sizeBytes: PDF.length,
    });
    expect(mockUpload).toHaveBeenCalledTimes(1);
    const [publicId, bytes, contentType] = mockUpload.mock.calls[0]!;
    expect(publicId).toMatch(new RegExp(`^${setup.folder}/[0-9a-f-]{36}/Proof-of-payment-Thandi\\.pdf$`));
    expect((bytes as Buffer).equals(PDF)).toBe(true);
    expect(contentType).toBe('application/pdf');
    const row = await documentRow(res.body.data.id);
    expect(row).toMatchObject({ inviteId: guest.inviteId, source: 'INVITE', attachedAt: null, cloudinaryPublicId: publicId });
  });

  it('accepts every allowed type by its content: JPG, PNG and a real XLSX', async () => {
    const setup = await newEvent();
    const guest = await newGuest(setup);
    const cases: [Buffer, string, string][] = [
      [JPG, 'proof.jpeg', 'image/jpeg'],
      [PNG, 'proof.png', 'image/png'],
      [await xlsxBuffer(), 'statement.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ];
    for (const [file, name, contentType] of cases) {
      const res = await uploadAsGuest(guest.token, setup.fieldId, file, name);
      expect(res.status, name).toBe(201);
      expect(res.body.data.contentType).toBe(contentType);
    }
  });

  it('refuses a renamed file by its content, whatever the name and stated type say, storing nothing', async () => {
    const setup = await newEvent();
    const guest = await newGuest(setup);
    const cases: [Buffer, string][] = [
      [EXE, 'proof.pdf'], // an executable renamed to .pdf
      [PNG, 'proof.pdf'], // a real PNG named as a PDF
      [await xlsmBuffer(), 'statement.xlsx'], // a macro workbook renamed to .xlsx
      [await xlsmBuffer(), 'statement.xlsm'],
      [Buffer.from('PK\u0003\u0004 not really a zip'), 'statement.xlsx'],
      [CSV, 'statement.xlsx'], // a CSV named as a workbook
    ];
    for (const [file, name] of cases) {
      const res = await request(app)
        .post('/api/rsvp/documents')
        .field('token', guest.token)
        .field('rsvpFieldId', setup.fieldId)
        .attach('file', file, { filename: name, contentType: 'application/pdf' });
      expect(res.status, name).toBe(422);
      expect(res.body.code, name).toBe('DOCUMENT_TYPE_NOT_ALLOWED');
    }
    expect(mockUpload).not.toHaveBeenCalled();
    expect(await prisma.guestDocument.count({ where: { eventId: setup.eventId } })).toBe(0);
  });

  it('refuses a CSV, even named and stated as one: only PDF, JPG, PNG and XLSX are allowed', async () => {
    const setup = await newEvent();
    const guest = await newGuest(setup);
    for (const file of [CSV, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), CSV])]) {
      const res = await request(app)
        .post('/api/rsvp/documents')
        .field('token', guest.token)
        .field('rsvpFieldId', setup.fieldId)
        .attach('file', file, { filename: 'statement.csv', contentType: 'text/csv' });
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: 'DOCUMENT_TYPE_NOT_ALLOWED', message: "This file type can't be uploaded. Use a PDF, JPG, PNG or XLSX file." });
    }
    expect(mockUpload).not.toHaveBeenCalled();
    expect(await prisma.guestDocument.count({ where: { eventId: setup.eventId } })).toBe(0);
  });

  it('takes exactly 5 MB and refuses one byte more with 413 DOCUMENT_TOO_LARGE', async () => {
    const setup = await newEvent();
    const guest = await newGuest(setup);
    const fiveMb = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(5 * 1024 * 1024 - 9, 0x20)]);
    expect(fiveMb.length).toBe(5 * 1024 * 1024);

    const ok = await uploadAsGuest(guest.token, setup.fieldId, fiveMb, 'big.pdf');
    expect(ok.status).toBe(201);

    const tooBig = await uploadAsGuest(guest.token, setup.fieldId, Buffer.concat([fiveMb, Buffer.from(' ')]), 'bigger.pdf');
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.code).toBe('DOCUMENT_TOO_LARGE');
    expect(mockUpload).toHaveBeenCalledTimes(1);
  });

  it('refuses a question that is not one of the event\'s DOCUMENT questions, and a link that is not valid', async () => {
    const setup = await newEvent();
    const other = await newEvent();
    const guest = await newGuest(setup);

    const wrongField = await uploadAsGuest(guest.token, other.fieldId, PDF, 'proof.pdf');
    expect(wrongField.status).toBe(400);
    expect(wrongField.body.code).toBe('RSVP_ANSWER_UNKNOWN_FIELD');

    const badToken = await uploadAsGuest('f'.repeat(64), setup.fieldId, PDF, 'proof.pdf');
    expect(badToken.status).toBe(404);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('deletes the guest\'s earlier unsubmitted upload for the same question when they upload another', async () => {
    const setup = await newEvent();
    const guest = await newGuest(setup);
    const first = await uploadAsGuest(guest.token, setup.fieldId, PDF, 'first.pdf');
    const second = await uploadAsGuest(guest.token, setup.fieldId, PNG, 'second.png');
    expect(second.status).toBe(201);

    const firstRow = await documentRow(first.body.data.id);
    expect(firstRow.deletedAt).not.toBeNull();
    expect(destroyedIds()).toEqual([firstRow.cloudinaryPublicId]);
    expect(destroyCallFor(firstRow.cloudinaryPublicId)).toMatchObject({ resourceType: 'raw', params: { type: 'private' } });
    expect((await documentRow(second.body.data.id)).deletedAt).toBeNull();
  });

  it('never logs the file name', async () => {
    const setup = await newEvent();
    const guest = await newGuest(setup);
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    mockUpload.mockResolvedValueOnce({ ok: false, reason: `Upload failed for ${setup.folder}/x/Secret-Name.pdf` });

    const failed = await uploadAsGuest(guest.token, setup.fieldId, PDF, 'Secret Name.pdf');
    expect(failed.status).toBe(503);
    expect(JSON.stringify(failed.body)).not.toContain('Secret');
    await uploadAsGuest(guest.token, setup.fieldId, PDF, 'Secret Name.pdf');

    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    expect(logged).not.toMatch(/Secret/);
    spies.forEach((s) => s.mockRestore());
  });

  it('keeps file names and document paths out of Sentry', () => {
    const scrubbed = scrubValue({ fileName: 'Proof Thandi Nkosi.pdf', originalname: 'Proof Thandi Nkosi.pdf', cloudinaryPublicId: 'x' });
    expect(JSON.stringify(scrubbed)).not.toContain('Thandi');
    const text = scrubText('destroy failed: eventgenie/t1/documents/e1/0b8f7c1e-3f2a-4d4b-9c1d-2a3b4c5d6e7f/Proof-Thandi-Nkosi.pdf');
    expect(text).not.toContain('Thandi');
  });
});

// ── Answering ─────────────────────────────

describe('a DOCUMENT answer at RSVP', () => {
  it('attaches the upload; the guest page prefills it and shows the question with its description', async () => {
    const setup = await newEvent();
    const { token, documentId } = await receivedDocument(setup);

    expect((await documentRow(documentId)).attachedAt).not.toBeNull();
    const view = await request(app).get(`/api/rsvp/validate/${token}`);
    expect(view.status).toBe(200);
    expect(view.body.data.invite.event.rsvpFields).toEqual([
      {
        id: setup.fieldId,
        label: 'Proof of payment',
        description: 'Pay R150 to the club, then upload the proof.',
        fieldType: 'DOCUMENT',
        isRequired: true,
        options: null,
      },
    ]);
    expect(view.body.data.rsvpResponses).toEqual([{ rsvpFieldId: setup.fieldId, value: documentId }]);
    expect(view.body.data.documents).toEqual([
      expect.objectContaining({ id: documentId, rsvpFieldId: setup.fieldId, fileName: 'Proof of payment (Thandi).pdf' }),
    ]);
  });

  it('refuses a required DOCUMENT question left without a file with DOCUMENT_REQUIRED, writing nothing', async () => {
    const setup = await newEvent();
    const guest = await newGuest(setup);

    const res = await submit(guest.token, setup, null);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('DOCUMENT_REQUIRED');
    expect(res.body.message).toBe("Please upload 'Proof of payment'. The organiser needs it to confirm your place.");
    expect((await prisma.invite.findUniqueOrThrow({ where: { id: guest.inviteId } })).used).toBe(false);
    // A decline needs no file.
    expect((await submit(guest.token, setup, null, false)).status).toBe(200);
  });

  it('refuses another guest\'s document, another event\'s, and a deleted one, with one code and nothing attached', async () => {
    const setup = await newEvent();
    const mine = await newGuest(setup);
    const someoneElse = await newGuest(setup);
    const otherEvent = await newEvent();
    const otherEventGuest = await newGuest(otherEvent);

    const theirs = await uploadAsGuest(someoneElse.token, setup.fieldId, PDF, 'theirs.pdf');
    const otherEvents = await uploadAsGuest(otherEventGuest.token, otherEvent.fieldId, PDF, 'other.pdf');
    const deleted = await uploadAsGuest(mine.token, setup.fieldId, PDF, 'old.pdf');
    await prisma.guestDocument.update({ where: { id: deleted.body.data.id }, data: { deleteRequestedAt: new Date() } });

    for (const id of [theirs.body.data.id, otherEvents.body.data.id, deleted.body.data.id, 'not-a-document']) {
      const res = await submit(mine.token, setup, id);
      expect(res.status, id).toBe(422);
      expect(res.body.code, id).toBe('DOCUMENT_REFERENCE_INVALID');
      expect(res.body.message).toBe("The file for 'Proof of payment' couldn't be found. Please upload it again.");
    }
    expect((await documentRow(theirs.body.data.id)).attachedAt).toBeNull();
    expect((await documentRow(otherEvents.body.data.id)).attachedAt).toBeNull();
    expect(await prisma.rsvpResponse.count({ where: { inviteId: mine.inviteId } })).toBe(0);
  });

  it('replacing the file at RSVP deletes the one sent before, once the reply is saved', async () => {
    const setup = await newEvent();
    const { token, documentId } = await receivedDocument(setup);
    const replacement = await uploadAsGuest(token, setup.fieldId, PNG, 'new.png');
    expect(destroyedIds()).toEqual([]); // the submitted file stays until the new reply

    expect((await submit(token, setup, replacement.body.data.id)).status).toBe(200);

    const old = await documentRow(documentId);
    expect(old.deletedAt).not.toBeNull();
    expect(destroyedIds()).toEqual([old.cloudinaryPublicId]);
    expect((await documentRow(replacement.body.data.id)).deletedAt).toBeNull();
  });
});

describe('a DOCUMENT answer at public registration', () => {
  it('uploads against the registration page and attaches to the new registrant', async () => {
    const setup = await newEvent({ visibility: 'PUBLIC' });
    const view = await request(app).get(`/api/public-events/${setup.shareToken}`);
    expect(view.body.data.rsvpFields[0]).toMatchObject({ id: setup.fieldId, fieldType: 'DOCUMENT', description: expect.any(String) });

    const upload = await uploadAsRegistrant(setup.shareToken!, setup.fieldId, PDF, 'proof.pdf');
    expect(upload.status).toBe(201);
    expect((await documentRow(upload.body.data.id))).toMatchObject({ source: 'REGISTRATION', inviteId: null });

    const email = `reg-${randomBytes(6).toString('hex')}@test.invalid`;
    const res = await request(app)
      .post(`/api/public-events/${setup.shareToken}/register`)
      .send({ firstName: 'Sipho', email, rsvpResponses: [{ rsvpFieldId: setup.fieldId, value: upload.body.data.id }] });
    expect(res.status).toBe(201);

    const guest = await prisma.guest.findFirstOrThrow({ where: { eventId: setup.eventId, email } });
    const invite = await prisma.invite.findFirstOrThrow({ where: { guestId: guest.id } });
    expect(await documentRow(upload.body.data.id)).toMatchObject({ inviteId: invite.id, attachedAt: expect.any(Date) });
  });

  it('refuses a registration without the required file, and one naming a document already claimed', async () => {
    const setup = await newEvent({ visibility: 'PUBLIC' });
    const missing = await request(app)
      .post(`/api/public-events/${setup.shareToken}/register`)
      .send({ firstName: 'Sipho', email: `reg-${randomBytes(6).toString('hex')}@test.invalid` });
    expect(missing.status).toBe(422);
    expect(missing.body.code).toBe('DOCUMENT_REQUIRED');

    // An invitation's upload on the same event can't be claimed by a registrant.
    const guest = await newGuest(setup);
    const invites = await uploadAsGuest(guest.token, setup.fieldId, PDF, 'proof.pdf');
    const claimed = await request(app)
      .post(`/api/public-events/${setup.shareToken}/register`)
      .send({ firstName: 'Sipho', email: `reg-${randomBytes(6).toString('hex')}@test.invalid`, rsvpResponses: [{ rsvpFieldId: setup.fieldId, value: invites.body.data.id }] });
    expect(claimed.status).toBe(422);
    expect(claimed.body.code).toBe('DOCUMENT_REFERENCE_INVALID');
  });
});

// ── The organiser ─────────────────────────

describe('the organiser viewing a document', () => {
  it('guest details show what was received; the export says Received, never a link', async () => {
    const setup = await newEvent();
    const { inviteId, documentId } = await receivedDocument(setup);

    const details = await request(app).get(`/api/invites/${inviteId}/rsvp-responses`).set(headersFor(organiser));
    expect(details.status).toBe(200);
    expect(details.body.data[0].document).toEqual({
      id: documentId,
      fileName: 'Proof of payment (Thandi).pdf',
      contentType: 'application/pdf',
      sizeBytes: PDF.length,
      uploadedAt: expect.any(String),
    });

    const exported = await request(app)
      .get(`/api/events/${setup.eventId}/guests/export`)
      .set(headersFor(organiser))
      .buffer(true)
      .parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(exported.status).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(exported.body as unknown as ArrayBuffer);
    const sheet = workbook.getWorksheet('Guests')!;
    const header = (sheet.getRow(1).values as unknown[]).indexOf('Proof of payment');
    const cells = sheet.getColumn(header).values.slice(2).map(String);
    expect(cells).toEqual(['Received']);
    expect(JSON.stringify(sheet.getSheetValues())).not.toMatch(/cloudinary|https?:|Thandi\)\.pdf/);
  });

  it('gives an event admin a signed private link that expires in 5 minutes and downloads with the file name', async () => {
    const setup = await newEvent();
    const { documentId } = await receivedDocument(setup);
    const row = await documentRow(documentId);
    const before = Math.floor(Date.now() / 1000);

    const res = await request(app).get(`/api/events/${setup.eventId}/documents/${documentId}/link`).set(headersFor(organiser));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ fileName: 'Proof of payment (Thandi).pdf', contentType: 'application/pdf', sizeBytes: PDF.length });
    const url = new URL(res.body.data.url);
    expect(`${url.origin}${url.pathname}`).toBe(`https://api.cloudinary.com/v1_1/${CLOUD}/raw/download`);
    const params = Object.fromEntries(url.searchParams);
    expect(params).toMatchObject({ public_id: row.cloudinaryPublicId, type: 'private', attachment: 'true' });
    expect(row.cloudinaryPublicId.endsWith('/Proof-of-payment-Thandi.pdf')).toBe(true);

    // Five minutes, and the expiry is part of what is signed.
    const expiresAt = Number(params['expires_at']);
    expect(expiresAt - Number(params['timestamp'])).toBe(300);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 300);
    expect(expiresAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 300);
    expect(Math.floor(new Date(res.body.data.expiresAt).getTime() / 1000)).toBe(expiresAt);
    const sign = (p: Record<string, string>) =>
      createHash('sha1')
        .update(Object.keys(p).sort().map((k) => `${k}=${p[k]}`).join('&') + API_SECRET)
        .digest('hex');
    const { api_key: _key, signature, ...signed } = params;
    expect(sign(signed as Record<string, string>)).toBe(signature);
    expect(sign({ ...(signed as Record<string, string>), expires_at: String(expiresAt + 3600) })).not.toBe(signature);
  });

  it('is the standard 404 for another tenant, a locked member, a vendor, another event, and an unsubmitted upload', async () => {
    const setup = await newEvent();
    const other = await newEvent();
    const { documentId } = await receivedDocument(setup);
    await assign(tenantId, lockedMember.id, other.eventId, organiser.id);
    const pending = await uploadAsGuest((await newGuest(setup)).token, setup.fieldId, PDF, 'pending.pdf');

    const link = (actor: Actor, eventId: string, id: string) =>
      request(app).get(`/api/events/${eventId}/documents/${id}/link`).set(headersFor(actor));

    const outsiders = await link(outsider, setup.eventId, documentId);
    expect(outsiders.status).toBe(404);
    expect(outsiders.body).toEqual({ status: 'error', message: 'Event not found' });
    expect((await link(lockedMember, setup.eventId, documentId)).status).toBe(404);
    const vendors = await link(vendor, setup.eventId, documentId);
    expect(vendors.status).toBe(404);
    expect(vendors.body).toEqual(ROUTE_NOT_FOUND_BODY);
    const wrongEvent = await link(organiser, other.eventId, documentId);
    expect(wrongEvent.status).toBe(404);
    expect(wrongEvent.body).toEqual({ status: 'error', message: 'Document not found' });
    expect((await link(organiser, setup.eventId, pending.body.data.id)).status).toBe(404);
    expect((await request(app).get(`/api/events/${setup.eventId}/documents/${documentId}/link`)).status).toBe(401);
  });

  it('counts kept documents in the event\'s own document storage, never the Memory Hub\'s', async () => {
    const setup = await newEvent();
    const hubBefore = await memoryHubRepository.sumBytesForEvent(setup.eventId);
    await receivedDocument(setup);
    expect(await guestDocumentRepository.sumLiveBytesForEvent(setup.eventId)).toBe(PDF.length);
    expect(await memoryHubRepository.sumBytesForEvent(setup.eventId)).toBe(hubBefore);
  });
});

// ── Deleting ──────────────────────────────

describe('deleting documents', () => {
  it('keeps a guest\'s files when the guest is removed: the link still works, and restoring brings them back', async () => {
    const setup = await newEvent();
    const { guestId, documentId } = await receivedDocument(setup);

    const res = await request(app).delete(`/api/guests/${guestId}`).set(headersFor(organiser));
    expect(res.status).toBe(200);

    expect(await documentRow(documentId)).toMatchObject({ deletedAt: null, deleteRequestedAt: null });
    expect(destroyedIds()).toEqual([]);
    expect((await request(app).get(`/api/events/${setup.eventId}/documents/${documentId}/link`).set(headersFor(organiser))).status).toBe(200);

    expect((await request(app).post(`/api/guests/${guestId}/reactivate`).set(headersFor(organiser))).status).toBe(200);
    const detail = await request(app).get(`/api/guests/${guestId}`).set(headersFor(organiser));
    expect(detail.body.data.documentCount).toBe(1);
  });

  it('a deletion Cloudinary refuses stays requested, with its reason, and the storage worker retries it', async () => {
    const setup = await newEvent();
    const { documentId } = await receivedDocument(setup);
    const { cloudinaryPublicId } = await documentRow(documentId);
    fakeCloudinary.failDestroy.add(cloudinaryPublicId);

    expect((await request(app).delete(`/api/events/${setup.eventId}`).set(headersFor(organiser))).status).toBe(200);
    expect(await documentRow(documentId)).toMatchObject({ deletedAt: null, deleteRequestedAt: expect.any(Date) });
    expect((await documentRow(documentId)).lastDeleteError).toBe('HTTP 500');

    fakeCloudinary.failDestroy.clear();
    await storageDeletionWorker.runOnce(new Date(Date.now() + 2 * 60_000));
    expect((await documentRow(documentId)).deletedAt).not.toBeNull();
  });

  it('deletes every file of an event when the event is deleted', async () => {
    const setup = await newEvent();
    const { documentId } = await receivedDocument(setup);
    const pending = await uploadAsGuest((await newGuest(setup)).token, setup.fieldId, PDF, 'pending.pdf');

    expect((await request(app).delete(`/api/events/${setup.eventId}`).set(headersFor(organiser))).status).toBe(200);

    for (const id of [documentId, pending.body.data.id]) expect((await documentRow(id)).deletedAt).not.toBeNull();
  });

  it('the archived-event purge deletes any document still kept, counted in the purge', async () => {
    const setup = await newEvent();
    const { documentId } = await receivedDocument(setup);
    // Archived 31 days ago without going through archive (which deletes at
    // once): the purge is the backstop for whatever is left.
    await prisma.event.update({ where: { id: setup.eventId }, data: { isArchived: true, archivedAt: new Date(Date.now() - 31 * DAY_MS) } });

    const result = await mediaRetentionService.sweep();

    const purge = result.purges.find((p) => p.eventId === setup.eventId);
    expect(purge).toMatchObject({ completed: true, purgedCount: 1, failedCount: 0 });
    const row = await documentRow(documentId);
    expect(row.deletedAt).not.toBeNull();
    expect(destroyedIds()).toContain(row.cloudinaryPublicId);
  });

  it('the sweep deletes uploads never attached within 24 hours, and nothing else', async () => {
    const setup = await newEvent();
    const guest = await newGuest(setup);
    const old = await uploadAsGuest(guest.token, setup.fieldId, PDF, 'old.pdf');
    const young = await uploadAsGuest((await newGuest(setup)).token, setup.fieldId, PDF, 'young.pdf');
    const attached = await receivedDocument(setup);
    await prisma.guestDocument.update({ where: { id: old.body.data.id }, data: { uploadedAt: new Date(Date.now() - 25 * DAY_MS / 24) } });
    await prisma.guestDocument.update({ where: { id: young.body.data.id }, data: { uploadedAt: new Date(Date.now() - 23 * DAY_MS / 24) } });
    await prisma.guestDocument.update({ where: { id: attached.documentId }, data: { uploadedAt: new Date(Date.now() - 30 * DAY_MS) } });

    await guestDocumentService.sweep();

    expect((await documentRow(old.body.data.id)).deletedAt).not.toBeNull();
    expect((await documentRow(young.body.data.id)).deletedAt).toBeNull();
    expect((await documentRow(attached.documentId)).deletedAt).toBeNull();
    // A swept upload can no longer be the answer.
    const late = await submit(guest.token, setup, old.body.data.id);
    expect(late.status).toBe(422);
    expect(late.body.code).toBe('DOCUMENT_REFERENCE_INVALID');
  });
});

// ── The flag ──────────────────────────────

describe('changing a question to or from DOCUMENT', () => {
  const putField = (eventId: string, fieldId: string, body: Record<string, unknown>) =>
    request(app).put(`/api/events/${eventId}/rsvp-fields/${fieldId}`).set(headersFor(organiser)).send(body);

  it('is refused with 409 RSVP_FIELD_TYPE_LOCKED once the question has answers, on both edit paths', async () => {
    const setup = await newEvent();
    await prisma.event.update({ where: { id: setup.eventId }, data: { hostName: 'Durban Chess Club' } });
    const { inviteId } = await receivedDocument(setup);

    // A DOCUMENT question with a file received can't become text.
    const fromDocument = await putField(setup.eventId, setup.fieldId, { fieldType: 'TEXT' });
    expect(fromDocument.status).toBe(409);
    expect(fromDocument.body).toMatchObject({
      code: 'RSVP_FIELD_TYPE_LOCKED',
      message: "'Proof of payment' already has answers, so it can't be changed to or from a file upload. Add a new field instead.",
    });
    const viaFullUpdate = await request(app)
      .put(`/api/events/${setup.eventId}/full`)
      .set(headersFor(organiser))
      .send({ rsvpFields: [{ id: setup.fieldId, label: 'Proof of payment', fieldType: 'TEXT', isRequired: true }] });
    expect(viaFullUpdate.status).toBe(409);
    expect(viaFullUpdate.body.code).toBe('RSVP_FIELD_TYPE_LOCKED');
    expect((await prisma.rsvpField.findUniqueOrThrow({ where: { id: setup.fieldId } })).fieldType).toBe('DOCUMENT');

    // A text question with an answer can't become a DOCUMENT one.
    const club = await prisma.rsvpField.create({
      data: { eventId: setup.eventId, label: 'Club', fieldType: 'TEXT', isRequired: false, order: 1, createdBy: organiser.id, updatedBy: organiser.id },
    });
    await prisma.rsvpResponse.create({ data: { inviteId, rsvpFieldId: club.id, value: 'Durban Chess Club' } });
    const toDocument = await putField(setup.eventId, club.id, { fieldType: 'DOCUMENT' });
    expect(toDocument.status).toBe(409);
    expect(toDocument.body.code).toBe('RSVP_FIELD_TYPE_LOCKED');
    expect((await prisma.rsvpField.findUniqueOrThrow({ where: { id: club.id } })).fieldType).toBe('TEXT');

    // Every other edit of an answered question still saves, and so does a
    // type change between two non-DOCUMENT types.
    expect((await putField(setup.eventId, setup.fieldId, { label: 'Proof of payment (R150)', fieldType: 'DOCUMENT' })).status).toBe(200);
    expect((await putField(setup.eventId, club.id, { fieldType: 'DROPDOWN', options: '["Durban Chess Club","Other"]' })).status).toBe(200);
  });

  it('is allowed while the question has no answers (a blank one is not an answer)', async () => {
    const setup = await newEvent({ required: false });
    const guest = await newGuest(setup);
    await prisma.rsvpResponse.create({ data: { inviteId: guest.inviteId, rsvpFieldId: setup.fieldId, value: '' } });

    const toText = await putField(setup.eventId, setup.fieldId, { fieldType: 'TEXT' });
    expect(toText.status).toBe(200);
    const backToDocument = await putField(setup.eventId, setup.fieldId, { fieldType: 'DOCUMENT' });
    expect(backToDocument.status).toBe(200);
  });
});

describe('documentFields off', () => {
  it('refuses uploads and new DOCUMENT questions with a code, hides the question from guests, and keeps what was received', async () => {
    const setup = await newEvent({ visibility: 'PUBLIC' });
    const { token, inviteId, documentId } = await receivedDocument(setup);
    mockUpload.mockClear();
    vi.stubEnv('FEATURES_DISABLED', 'documentFields');

    const upload = await uploadAsGuest(token, setup.fieldId, PDF, 'proof.pdf');
    expect(upload.status).toBe(422);
    expect(upload.body.code).toBe('DOCUMENT_FIELDS_UNAVAILABLE');
    const registrationUpload = await uploadAsRegistrant(setup.shareToken!, setup.fieldId, PDF, 'proof.pdf');
    expect(registrationUpload.status).toBe(422);
    expect(registrationUpload.body.code).toBe('DOCUMENT_FIELDS_UNAVAILABLE');
    expect(mockUpload).not.toHaveBeenCalled();

    const newField = await request(app)
      .post(`/api/events/${setup.eventId}/rsvp-fields`)
      .set(headersFor(organiser))
      .send({ label: 'ID copy', fieldType: 'DOCUMENT', order: 1 });
    expect(newField.status).toBe(422);
    expect(newField.body.code).toBe('DOCUMENT_FIELDS_UNAVAILABLE');
    const textField = await request(app)
      .post(`/api/events/${setup.eventId}/rsvp-fields`)
      .set(headersFor(organiser))
      .send({ label: 'Club', fieldType: 'TEXT', order: 1 });
    expect(textField.status).toBe(201);
    const changedTo = await request(app)
      .put(`/api/events/${setup.eventId}/rsvp-fields/${textField.body.data.id}`)
      .set(headersFor(organiser))
      .send({ fieldType: 'DOCUMENT' });
    expect(changedTo.body.code).toBe('DOCUMENT_FIELDS_UNAVAILABLE');
    // A saved DOCUMENT question re-sent unchanged still saves.
    const resent = await request(app)
      .put(`/api/events/${setup.eventId}/rsvp-fields/${setup.fieldId}`)
      .set(headersFor(organiser))
      .send({ label: 'Proof of payment', fieldType: 'DOCUMENT' });
    expect(resent.status).toBe(200);

    // Guests see no DOCUMENT question, and it isn't required of them.
    const view = await request(app).get(`/api/rsvp/validate/${token}`);
    expect(view.body.data.invite.event.rsvpFields.map((f: { fieldType: string }) => f.fieldType)).toEqual(['TEXT']);
    expect(view.body.data.rsvpResponses).toEqual([]);
    expect(view.body.data.documents).toEqual([]);
    expect((await request(app).get(`/api/public-events/${setup.shareToken}`)).body.data.rsvpFields.map((f: { fieldType: string }) => f.fieldType)).toEqual(['TEXT']);
    const reply = await submit(token, setup, null);
    expect(reply.status).toBe(200);

    // What was received is kept: the answer, the file, and no deletion.
    expect(await prisma.rsvpResponse.count({ where: { inviteId, value: documentId } })).toBe(1);
    expect((await documentRow(documentId)).deleteRequestedAt).toBeNull();
    expect(destroyedIds()).toEqual([]);

    // The organiser's link is the global 404.
    const link = await request(app).get(`/api/events/${setup.eventId}/documents/${documentId}/link`).set(headersFor(organiser));
    expect(link.status).toBe(404);
    expect(link.body).toEqual(ROUTE_NOT_FOUND_BODY);
  });

  it('leaves an event without documents exactly as before', async () => {
    vi.stubEnv('FEATURES_DISABLED', 'documentFields');
    const { event, day } = await createEventWithDay(tenantId, organiser.id);
    const field = await prisma.rsvpField.create({
      data: { eventId: event.id, label: 'Dietary needs', fieldType: 'TEXT', isRequired: true, order: 0, createdBy: organiser.id, updatedBy: organiser.id },
    });
    const guest = await newGuest({ eventId: event.id, dayId: day.id, fieldId: field.id, folder: '' });

    const missing = await request(app).post('/api/rsvp/submit').send({ token: guest.token, attending: true, attendingDayIds: [day.id] });
    expect(missing.body.code).toBe('RSVP_ANSWER_REQUIRED');
    const ok = await request(app)
      .post('/api/rsvp/submit')
      .send({ token: guest.token, attending: true, attendingDayIds: [day.id], rsvpResponses: [{ rsvpFieldId: field.id, value: 'None' }] });
    expect(ok.status).toBe(200);
    const view = await request(app).get(`/api/rsvp/validate/${guest.token}`);
    expect(view.body.data.invite.event.rsvpFields).toEqual([
      { id: field.id, label: 'Dietary needs', description: null, fieldType: 'TEXT', isRequired: true, options: null },
    ]);
  });
});
