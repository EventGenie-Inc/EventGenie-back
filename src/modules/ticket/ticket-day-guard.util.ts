import prisma from '../../shared/prisma/prisma.client.js';
import { type Prisma } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import { ticketRepository } from './ticket.repository.js';
import { ticketSalesCounts } from './ticket-sales-count.util.js';

type Db = Prisma.TransactionClient | typeof prisma;

export const EVENT_DAY_TICKET_ERROR_CODES = {
  HAS_SALES: 'EVENT_DAY_HAS_TICKET_SALES',
  ONLY_TICKET_DAY: 'EVENT_DAY_ONLY_TICKET_DAY',
} as const;

// ─────────────────────────────────────────
//  REMOVING AN EVENT DAY THAT TICKETS ADMIT (ticket sales Round A)
//
//  Every removal path (DELETE .../days/:id, a day left out of the full
//  update) asks this first. Refused when a ticket type with sales admits the
//  day (a type that admits every day admits it too): people paid for it.
//  Also refused when it is the only day a type admits, which would leave
//  the type admitting nothing: change the type first. Otherwise the day's
//  chosen-day rows go with it (forgetRemovedDays), in the removal's own
//  transaction.
// ─────────────────────────────────────────

// `planned`: what the same save does to ticket types (the full update):
// a type's new admitted days, or null for a type it deletes. A type with
// sales is judged on what it admits now (its days can't change anyway).
export const assertDaysRemovable = async (
  eventId: string,
  days: { id: string; label: string }[],
  db: Db = prisma,
  planned: Map<string, { admitsAllDays: boolean; admittedDayIds: string[] } | null> = new Map()
): Promise<void> => {
  if (days.length === 0) return;
  const removed = new Set(days.map((d) => d.id));
  for (const day of days) {
    const admitting = await ticketRepository.findAdmitting(eventId, day.id, db);
    if (admitting.length === 0) continue;
    const counts = await ticketSalesCounts(admitting.map((t) => t.id), db);
    const sold = admitting.find((t) => (counts.get(t.id)?.sold ?? 0) > 0);
    if (sold) {
      throw new HttpError(
        409,
        `'${day.label}' can't be removed: '${sold.name}' tickets admit it and have been sold.`,
        EVENT_DAY_TICKET_ERROR_CODES.HAS_SALES
      );
    }
    const stranded = admitting.find((t) => {
      const plan = planned.get(t.id);
      if (plan === null) return false; // deleted in the same save
      const allDays = plan ? plan.admitsAllDays : t.admitsAllDays;
      const chosen = plan ? plan.admittedDayIds : t.admittedDays.map((a) => a.eventDayId);
      return !allDays && chosen.includes(day.id) && chosen.every((id) => removed.has(id));
    });
    if (stranded) {
      throw new HttpError(
        409,
        `'${day.label}' is the only day '${stranded.name}' tickets admit. Change or delete that ticket type first.`,
        EVENT_DAY_TICKET_ERROR_CODES.ONLY_TICKET_DAY
      );
    }
  }
};

export const forgetRemovedDays = async (dayIds: string[], db: Db = prisma): Promise<void> => {
  for (const id of dayIds) await ticketRepository.forgetDay(id, db);
};
