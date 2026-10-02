import { attendanceRepository } from './attendance.repository.js';
import { inviteRepository } from '../invite/invite.repository.js';
import { eventDayRepository } from '../event-day/event-day.repository.js';
import { eventService } from '../event/event.service.js';
import { type PlatformRole } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';

// READ THIS BEFORE USING THIS MODULE FOR "WHO TURNED UP". An Attendance row
// is a guest's RSVP ANSWER for one day ("will attend"), written by
// rsvp.service.ts's submit() and rebuilt wholesale whenever they edit their
// RSVP — it is NOT arrival. Recording or deleting one here edits what the
// guest said they would do; it does not check anyone in. Day-of check-in is
// the check-in module (CheckIn table, /api/events/:eventId/check-in).
//
// Attendance has no tenantId of its own, and no :eventId route param either
// (this router is mounted flat at /api/attendance) — ownership is derived
// from the body-supplied inviteId's parent event, then gated through
// eventService.getById(), same shape as event-day/guest/invite. Attendance
// stays a genuine hard delete (no isArchived field) — that is intentional
// and untouched here.
export const attendanceService = {
  getAll: async (inviteId: string, requestingRole: PlatformRole, tenantId: string | null) => {
    const invite = await inviteRepository.findById(inviteId);
    if (!invite) throw new HttpError(404, 'Invite not found');
    await eventService.getById(invite.eventId, requestingRole, tenantId);
    return attendanceRepository.findAll(inviteId);
  },

  getById: async (id: string, requestingRole: PlatformRole, tenantId: string | null) => {
    const attendance = await attendanceRepository.findById(id);
    if (!attendance) throw new HttpError(404, 'Attendance record not found');
    await eventService.getById(attendance.invite.eventId, requestingRole, tenantId);
    return attendance;
  },

  create: async (
    inviteId: string,
    eventDayId: string,
    requestingRole: PlatformRole,
    tenantId: string | null
  ) => {
    const invite = await inviteRepository.findById(inviteId);
    if (!invite) throw new HttpError(404, 'Invite not found');
    await eventService.getById(invite.eventId, requestingRole, tenantId);

    // Closes a second cross-tenant hole: eventDayId was never verified to
    // belong to the same event as the invite, so a caller could attach an
    // eventDayId from a different tenant's event entirely.
    const eventDay = await eventDayRepository.findById(eventDayId);
    if (!eventDay || eventDay.eventId !== invite.eventId) {
      throw new HttpError(400, `Event day '${eventDayId}' does not belong to this invite's event`);
    }

    return attendanceRepository.create(inviteId, eventDayId);
  },

  delete: async (id: string, requestingRole: PlatformRole, tenantId: string | null) => {
    await attendanceService.getById(id, requestingRole, tenantId);
    return attendanceRepository.delete(id);
  },
};
