import { type PlanValues } from './effective-plan.util.js';
import { isFeatureEnabled, type FeatureName } from '../../shared/features/feature-flags.js';
import { documentLimitsFromConfig } from '../guest-document/guest-document-allowance.util.js';

// ─────────────────────────────────────────
//  PLAN SETTINGS — what a tenant's plan allows, for the frontend.
//
//  GET /api/tenants/me carries these so the frontend decides what to show
//  from the settings themselves, never from the plan's name: a SUPER_ADMIN
//  can switch any of them on for any tier, the free one included.
//
//  Each value is resolved exactly as the server enforces it (from the
//  effective plan, effective-plan.util.ts: a standard tier, or a custom
//  tier while current), from the
//  tier's SubscriptionTierConfig row, with the same fallback when there is
//  no row: limits unlimited (null), the on/off features off, and the four
//  capability settings their old in-code rule (tier-capabilities.util.ts).
//  Change an enforcement point's fallback and this must change with it.
//
//  A setting that belongs to a switched-off feature is left out entirely,
//  never sent as false: a tenant is never told about a feature that isn't
//  on offer (STEERING "Feature flags").
//
//  This is the TENANT's plan. An Event Pass can raise an event's own
//  entitlement above it; event-scoped numbers (an event's guest limit)
//  come with the event (event.service.ts's getDetail).
// ─────────────────────────────────────────

export interface PlanSettings {
  maxEvents: number | null; // null = unlimited
  maxGuestsPerEvent: number | null;
  maxSmsPerMonth?: number | null;
  maxVendorSpaces?: number | null;
  maxMemoryHubBytesPerEvent: number | null;
  // Guests' documents (documentFields): the event's allowance (null =
  // unlimited) and the most one document may be (always a number: the
  // plan's, else the upload route's fixed ceiling).
  maxDocumentBytesPerEvent?: number | null;
  maxDocumentBytesPerFile?: number;
  smsEnabled?: boolean;
  memoryHubEnabled: boolean;
  guestExportEnabled: boolean;
  vendorMarketplace?: boolean;
  publicEventsEnabled?: boolean;
  paidTicketingEnabled?: boolean;
  customRsvpFieldsEnabled: boolean;
  vendorPriorityPlacement?: boolean;
  // QR check-in at the door (qrCheckIn). The guest-list check-in never
  // depends on it.
  qrCheckInEnabled?: boolean;
  // The invitation design editor (invitationDesigns): whether this plan may
  // save a CANVAS design.
  invitationDesignsEnabled?: boolean;
}

type FeatureSettingKey =
  | 'maxSmsPerMonth'
  | 'smsEnabled'
  | 'maxVendorSpaces'
  | 'vendorMarketplace'
  | 'vendorPriorityPlacement'
  | 'publicEventsEnabled'
  | 'paidTicketingEnabled'
  | 'maxDocumentBytesPerEvent'
  | 'maxDocumentBytesPerFile'
  | 'qrCheckInEnabled'
  | 'invitationDesignsEnabled';

// Which feature flag each optional setting belongs to.
const SETTING_FEATURE: Record<FeatureSettingKey, FeatureName> = {
  maxSmsPerMonth: 'sms',
  smsEnabled: 'sms',
  maxVendorSpaces: 'vendors',
  vendorMarketplace: 'vendors',
  vendorPriorityPlacement: 'vendors',
  publicEventsEnabled: 'publicEvents',
  paidTicketingEnabled: 'ticketing',
  maxDocumentBytesPerEvent: 'documentFields',
  maxDocumentBytesPerFile: 'documentFields',
  qrCheckInEnabled: 'qrCheckIn',
  invitationDesignsEnabled: 'invitationDesigns',
};

// From the effective plan's settings (effective-plan.util.ts: a standard
// tier with its no-row fallback, or a custom tier), exactly as enforced.
export const planSettingsFromValues = (values: PlanValues): PlanSettings => {
  const settings: PlanSettings = {
    maxEvents: values.maxEvents,
    maxGuestsPerEvent: values.maxGuestsPerEvent,
    maxSmsPerMonth: values.maxSmsPerMonth,
    maxVendorSpaces: values.maxVendorSpaces,
    maxMemoryHubBytesPerEvent: values.maxMemoryHubBytesPerEvent,
    // The same resolution the upload enforces (guest-document-allowance.util.ts).
    maxDocumentBytesPerEvent: documentLimitsFromConfig(values).maxBytesPerEvent,
    maxDocumentBytesPerFile: documentLimitsFromConfig(values).maxBytesPerDocument,
    smsEnabled: values.smsEnabled,
    memoryHubEnabled: values.memoryHubEnabled,
    guestExportEnabled: values.guestExportEnabled,
    vendorMarketplace: values.vendorMarketplace,
    publicEventsEnabled: values.publicEventsEnabled,
    paidTicketingEnabled: values.paidTicketingEnabled,
    customRsvpFieldsEnabled: values.customRsvpFieldsEnabled,
    vendorPriorityPlacement: values.vendorPriorityPlacement,
    qrCheckInEnabled: values.qrCheckInEnabled,
    invitationDesignsEnabled: values.invitationDesignsEnabled,
  };

  for (const [key, feature] of Object.entries(SETTING_FEATURE) as [FeatureSettingKey, FeatureName][]) {
    if (!isFeatureEnabled(feature)) delete settings[key];
  }
  return settings;
};
