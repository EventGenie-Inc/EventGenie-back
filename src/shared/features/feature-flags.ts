// ─────────────────────────────────────────
//  FEATURE REGISTRY
//
//  Every optional feature, by its stable name. Production can run a
//  reduced set while dev keeps everything: one codebase, features
//  switched off by configuration, never deleted. Switching a flag off
//  hides the feature; it never touches the feature's data.
//
//  Read from FEATURES_DISABLED, a comma-separated list of names, e.g.
//    FEATURES_DISABLED=vendors,ticketing,sms,wallet,settingsPage,invitationDesigns
//  Unset or blank means everything is on. A name not in FEATURE_NAMES is a
//  startup error (assertFeatureConfigValid, called when app.ts loads), never
//  silently ignored: a typo like "ticket" would otherwise leave a feature
//  on in production with nobody noticing. Names are case-sensitive.
//
//  Enforcement: routes are guarded by requireFeature
//  (shared/middleware/feature.middleware.ts), one guard per router or route.
//  The frontend reads GET /api/config/features and keeps no copy of these.
// ─────────────────────────────────────────

export const FEATURE_NAMES = [
  'vendors',
  'ticketing',
  'sms',
  'wallet',
  'settingsPage',
  'invitationDesigns',
  'teamMembers',
  'publicEvents',
  'announcements',
  // Everything that starts or changes a payment (subscriptions, Event Pass
  // and SMS bundle purchases). Off for the free launch pilot; the Paystack
  // webhook and the read-only billing routes stay up either way.
  'payments',
  // Video in Memory Hub. Off: upload signatures are for photos only.
  'memoryHubVideo',
  // Memory Hub "download all": zip links for every approved item.
  'memoryHubDownload',
  // After an event: the organisers' feedback and sharing permissions, the
  // guests' own photo opt-in, the "How did it go?" email and the super
  // admin's feedback screens.
  'feedback',
  // Archived events' Memory Hub media deleted 30 days after archiving
  // (media-retention.service.ts): the sweep's reminders and purges, and the
  // super admin's purge. Off: nothing is reminded or deleted; archiving
  // still records archivedAt, so switching it on later counts from there.
  'archiveMediaPurge',
  // DOCUMENT questions: a guest uploads a file (a proof of payment, say) with
  // their RSVP or registration (guest-document module). Off: no DOCUMENT
  // question can be added, the upload routes refuse with
  // DOCUMENT_FIELDS_UNAVAILABLE, guests are never shown one, and the
  // organiser's view link is 404. Documents already received are kept.
  'documentFields',
  // The storage worker (storage/storage-deletion.worker.ts): files requested
  // for deletion (replaced, released, unsaved, a deleted event's) are
  // deleted from Cloudinary. Off: nothing is deleted by it, and requests
  // keep being recorded, to be deleted once it is back on. An emergency
  // stop; the documents pipeline and the archived-media purge have their own.
  'storageDeletion',
  // The storage retention rules (storage-retention.service.ts): rejected or
  // removed Memory Hub items deleted 7 days later; guests' documents deleted
  // when their event finishes (archived guests', invites' and questions'),
  // 90 days after it finishes (the rest), and 30 days after it is cancelled
  // (all), with the organisers' emails before the last two. Off: none of
  // these deletes anything or emails anyone, and no countdown (deletesAt)
  // is reported. The clocks keep running (rejectedAt, removedAt,
  // cancelledAt are recorded), so switching it on catches up.
  'storageRetention',
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];

export type FeatureFlags = Record<FeatureName, boolean>;

export const FEATURES_DISABLED_ENV = 'FEATURES_DISABLED';

const isFeatureName = (name: string): name is FeatureName =>
  (FEATURE_NAMES as readonly string[]).includes(name);

export const parseDisabledFeatures = (raw: string | undefined): Set<FeatureName> => {
  const names = (raw ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const unknown = names.filter((name) => !isFeatureName(name));
  if (unknown.length) {
    throw new Error(
      `${FEATURES_DISABLED_ENV} names unknown feature(s): ${unknown.join(', ')}. ` +
        `Known features: ${FEATURE_NAMES.join(', ')}.`
    );
  }
  return new Set(names as FeatureName[]);
};

// Read per call rather than cached at import: the string is a handful of
// names, and reading it live keeps tests able to switch a flag with
// vi.stubEnv. A bad value can't reach here at runtime, because
// assertFeatureConfigValid already refused to start the app.
export const isFeatureEnabled = (name: FeatureName): boolean =>
  !parseDisabledFeatures(process.env[FEATURES_DISABLED_ENV]).has(name);

export const getFeatureFlags = (): FeatureFlags => {
  const disabled = parseDisabledFeatures(process.env[FEATURES_DISABLED_ENV]);
  return Object.fromEntries(FEATURE_NAMES.map((name) => [name, !disabled.has(name)])) as FeatureFlags;
};

export const assertFeatureConfigValid = (): void => {
  parseDisabledFeatures(process.env[FEATURES_DISABLED_ENV]);
};
