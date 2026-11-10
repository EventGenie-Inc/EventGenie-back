import { type EventEmailKind } from '@prisma/client';

// Why an email wasn't queued: it is already waiting or going out, or the
// same email went to this invite a few minutes ago (a repeated Send, or a
// browser retrying the request).
export type NotQueuedReason = 'ALREADY_QUEUED' | 'RECENTLY_SENT';

export interface EnqueueResult {
  // The new send, or null when nothing was queued.
  sendId: string | null;
  queuedInviteIds: Set<string>;
  // Invites left out, with the send that already has (or had) their email.
  notQueued: Map<string, { reason: NotQueuedReason; sendId: string }>;
}

export interface EmailSendGuest {
  guestId: string;
  name: string;
  contact: string;
  reason: string;
}

// GET /api/events/:eventId/invites/sends/:sendId
export interface EmailSendProgress {
  id: string;
  kind: EventEmailKind;
  createdAt: string;
  total: number;
  // Waiting or going out right now.
  queued: number;
  sent: number;
  failed: number;
  // Not sent, nothing wrong: no longer needed when its turn came.
  skipped: number;
  // Nothing left waiting: queued === 0.
  done: boolean;
  // When the last email finished, once done.
  finishedAt: string | null;
  failures: EmailSendGuest[];
  skippedGuests: EmailSendGuest[];
}
