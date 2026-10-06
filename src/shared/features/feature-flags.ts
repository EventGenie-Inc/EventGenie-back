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
