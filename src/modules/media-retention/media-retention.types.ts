import { type EventMediaPurgeReason } from '@prisma/client';

// One attempt at a purge: what it deleted and what is left for the next
// sweep. completed: nothing left.
export interface MediaPurgeOutcome {
  purgeId: string;
  eventId: string;
  reason: EventMediaPurgeReason;
  purgedCount: number;
  failedCount: number;
  completed: boolean;
}

export interface MediaPurgeReminderOutcome {
  eventId: string;
  recipientCount: number;
  failedCount: number;
}

export interface MediaRetentionSweepResult {
  reminders: MediaPurgeReminderOutcome[];
  purges: MediaPurgeOutcome[];
}

// The super admin's answer: the purge as recorded.
export interface MediaPurgeView {
  eventId: string;
  reason: EventMediaPurgeReason;
  // The super admin who asked, or null for the sweep.
  requestedBy: string | null;
  startedAt: Date;
  completedAt: Date | null;
  // Across every attempt.
  purgedCount: number;
  // Left after the latest attempt, retried by the next sweep.
  failedCount: number;
}
