import { type SmsDeliveryStatus } from '@prisma/client';

// One SMSPortal delivery report, as their default webhook template sends
// it (camelCase keys; the PascalCase variable names are accepted too).
// Only the fields we use are listed. Docs: "Webhook types and variables".
export interface SmsPortalDeliveryReport {
  customerId: string | undefined;
  eventId: string | undefined;
  status: string | undefined;
  sentDataPartsCount?: number;
}

// What a report's Status means for us. SUBMITD and STAGED are on the way:
// nothing to record yet.
export type ReportVerdict = { status: Extract<SmsDeliveryStatus, 'DELIVERED' | 'FAILED'>; reason: string | null } | null;

export interface DeliveryReportOutcome {
  received: number;
  recorded: number;
  // Not ours (no matching message), or an in-between status.
  ignored: number;
}
