import prisma from '../../shared/prisma/prisma.client.js';

export interface RegistrationSettingsWrite {
  registrationEmailDomains?: string[];
  registrationCap?: number | null;
  registrationClosesAt?: Date | null;
  registrationPlusOnesAllowed?: number;
}

// Event and EventDay have no tenantId of their own to check here: the
// service gates on eventService.getScopedWithPass (tenant scope and the
// assignment lock) before calling anything in this file.
export const registrationSettingsRepository = {
  // The event's settings and, when openDayIds is given, which of its live
  // days are open — one transaction, so a save is never half-applied.
  update: (eventId: string, userId: string, data: RegistrationSettingsWrite, openDayIds: string[] | null) =>
    prisma.$transaction(async (tx) => {
      await tx.event.update({
        where: { id: eventId },
        data: {
          ...(data.registrationEmailDomains !== undefined && { registrationEmailDomains: data.registrationEmailDomains }),
          ...(data.registrationCap !== undefined && { registrationCap: data.registrationCap }),
          ...(data.registrationClosesAt !== undefined && { registrationClosesAt: data.registrationClosesAt }),
          ...(data.registrationPlusOnesAllowed !== undefined && { registrationPlusOnesAllowed: data.registrationPlusOnesAllowed }),
          updatedBy: userId,
        },
      });
      if (openDayIds) {
        await tx.eventDay.updateMany({
          where: { eventId, isArchived: false, id: { in: openDayIds } },
          data: { openForRegistration: true, updatedBy: userId },
        });
        await tx.eventDay.updateMany({
          where: { eventId, isArchived: false, id: { notIn: openDayIds } },
          data: { openForRegistration: false, updatedBy: userId },
        });
      }
    }),
};
