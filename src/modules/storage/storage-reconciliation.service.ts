import crypto from 'crypto';
import { type StoredFileStatus } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import { listResources, type CloudinaryDeliveryType, type CloudinaryResourceType, type ListedResource } from '../../shared/cloudinary/cloudinary.client.js';
import { reportError } from '../../shared/monitoring/error-reporting.js';
import { environmentPrefix, LEGACY_PREFIX } from '../upload/upload-folders.js';
import { storedFileRepository } from './stored-file.repository.js';
import { storageReconciliationRepository, toReconciliationView, type ReconciliationTotals } from './storage-reconciliation.repository.js';

// ─────────────────────────────────────────
//  STORAGE RECONCILIATION — this environment's files in Cloudinary
//  against StoredFile, once a week. A REPORT: it never deletes, requests a
//  deletion, or changes a row. Super admins read it
//  (GET /api/admin/storage/reconciliations).
//
//  - ORPHANS: a file under this environment's prefix (<env>/) with no row,
//    or whose row says DELETED. Only this prefix: dev and staging share
//    one Cloudinary account, and an environment can't tell which of the
//    legacy files (eventgenie/...) are its own, so it never calls one an
//    orphan.
//  - MISSING: a row whose file should be there (UPLOADED, ATTACHED) and
//    isn't. Legacy rows are checked against a listing of the legacy prefix.
//  - SIZE DIFFERENCES: a row's bytes against Cloudinary's. A legacy Memory
//    Hub row's bytes was the browser's report, so it can differ.
//
//  Admin API GETs only (500 per page), well inside its hourly limit once a
//  week. Each list in `details` is capped; the counts are not. A guest
//  document's public id ends in its file name, so that segment is never
//  written into the report.
// ─────────────────────────────────────────

const DETAIL_CAP = 200;
const ROW_PAGE = 1000;
const RESOURCE_TYPES: CloudinaryResourceType[] = ['image', 'video', 'raw'];
const DELIVERY_TYPES: CloudinaryDeliveryType[] = ['upload', 'private'];
const SHOULD_EXIST: StoredFileStatus[] = ['UPLOADED', 'ATTACHED'];

const redact = (publicId: string): string =>
  /\/(document|documents)\//.test(publicId) ? publicId.replace(/\/[^/]+$/, '/<file name>') : publicId;

// ISO week, e.g. "2026-W45": one weekly run claimed per week.
export const isoWeekKey = (now: Date): string => {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
};

const listAll = async (prefix: string): Promise<Map<string, ListedResource>> => {
  const listed = new Map<string, ListedResource>();
  for (const resourceType of RESOURCE_TYPES) {
    for (const type of DELIVERY_TYPES) {
      let cursor: string | null = null;
      do {
        const page = await listResources(resourceType, type, prefix, cursor);
        if (!page.ok) throw new Error(`Listing ${resourceType}/${type} failed: ${page.reason}`);
        for (const r of page.resources) listed.set(r.publicId, r);
        cursor = page.nextCursor;
      } while (cursor);
    }
  }
  return listed;
};

const rowsWithPrefix = async (prefix: string) => {
  const rows: Awaited<ReturnType<typeof storedFileRepository.findByPrefixPage>> = [];
  let after: string | null = null;
  for (;;) {
    const page = await storedFileRepository.findByPrefixPage(prefix, after, ROW_PAGE);
    rows.push(...page);
    if (page.length < ROW_PAGE) return rows;
    after = page[page.length - 1]!.id;
  }
};

export const reconcile = async () => {
  const envPrefix = environmentPrefix();
  const [envListed, legacyListed, envRows, legacyRows] = await Promise.all([
    listAll(envPrefix),
    listAll(LEGACY_PREFIX),
    rowsWithPrefix(envPrefix),
    rowsWithPrefix(LEGACY_PREFIX),
  ]);

  const rowByPublicId = new Map(envRows.map((r) => [r.publicId, r]));
  const orphans: { publicId: string; bytes: number; resourceType: string; type: string; createdAt: string; recordStatus: string | null }[] = [];
  const missing: { publicId: string; kind: string; status: string; legacy: boolean }[] = [];
  const sizeMismatches: { publicId: string; kind: string; recordBytes: number; cloudinaryBytes: number; legacy: boolean }[] = [];
  let orphanBytes = 0;
  let listedBytes = 0;

  for (const file of envListed.values()) {
    listedBytes += file.bytes;
    const row = rowByPublicId.get(file.publicId);
    if (!row || row.status === 'DELETED') {
      orphanBytes += file.bytes;
      orphans.push({ publicId: redact(file.publicId), bytes: file.bytes, resourceType: file.resourceType, type: file.type, createdAt: file.createdAt, recordStatus: row?.status ?? null });
    }
  }

  const check = (rows: typeof envRows, listed: Map<string, ListedResource>, legacy: boolean): void => {
    for (const row of rows) {
      const file = listed.get(row.publicId);
      if (!file) {
        if (SHOULD_EXIST.includes(row.status)) missing.push({ publicId: redact(row.publicId), kind: row.kind, status: row.status, legacy });
        continue;
      }
      if (row.bytes !== null && row.status !== 'DELETED' && row.bytes !== file.bytes) {
        sizeMismatches.push({ publicId: redact(row.publicId), kind: row.kind, recordBytes: row.bytes, cloudinaryBytes: file.bytes, legacy });
      }
    }
  };
  check(envRows, envListed, false);
  check(legacyRows, legacyListed, true);

  const totals: ReconciliationTotals = {
    listedCount: envListed.size,
    listedBytes,
    orphanCount: orphans.length,
    orphanBytes,
    missingCount: missing.length,
    sizeMismatchCount: sizeMismatches.length,
  };
  return {
    totals,
    details: {
      prefix: envPrefix,
      orphans: orphans.slice(0, DETAIL_CAP),
      missing: missing.slice(0, DETAIL_CAP),
      sizeMismatches: sizeMismatches.slice(0, DETAIL_CAP),
    },
  };
};

const runClaimed = async (id: string, now: Date) => {
  try {
    const { totals, details } = await reconcile();
    const done = await storageReconciliationRepository.finish(id, totals, details, new Date());
    if (totals.orphanCount > 0 || totals.missingCount > 0) {
      console.warn(`[storage] reconciliation ${id}: ${totals.orphanCount} orphan(s), ${totals.missingCount} missing, ${totals.sizeMismatchCount} size difference(s)`);
    }
    return done;
  } catch (err) {
    console.error(`[storage] reconciliation ${id} failed`);
    reportError(err);
    return storageReconciliationRepository.fail(id, err instanceof Error ? err.message : 'Unknown error', now);
  }
};

export const storageReconciliationService = {
  // The weekly run: claimed once per ISO week, whichever server gets there.
  runIfDue: async (now: Date = new Date()): Promise<boolean> => {
    const periodKey = isoWeekKey(now);
    if (await storageReconciliationRepository.findByPeriodKey(periodKey)) return false;
    const claimed = await storageReconciliationRepository.claim(periodKey, null, now);
    if (!claimed) return false;
    await runClaimed(claimed.id, now);
    return true;
  },

  // A super admin's run, now (POST /api/admin/storage/reconciliations).
  runNow: async (requestedBy: string, now: Date = new Date()) => {
    const claimed = await storageReconciliationRepository.claim(`manual-${crypto.randomUUID()}`, requestedBy, now);
    if (!claimed) throw new Error('Could not claim a reconciliation run');
    return toReconciliationView(await runClaimed(claimed.id, now), true);
  },

  list: async (take = 20) => (await storageReconciliationRepository.findRecent(take)).map((r) => toReconciliationView(r, false)),

  get: async (id: string) => {
    const found = await storageReconciliationRepository.findById(id);
    if (!found) throw new HttpError(404, 'Reconciliation not found');
    return toReconciliationView(found, true);
  },
};
