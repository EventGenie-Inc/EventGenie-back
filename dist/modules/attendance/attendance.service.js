import { attendanceRepository } from './attendance.repository.js';
import { inviteRepository } from '../invite/invite.repository.js';
import { eventDayRepository } from '../event-day/event-day.repository.js';
import { eventService } from '../event/event.service.js';
import {} from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
// Attendance has no tenantId of its own, and no :eventId route param either
// (this router is mounted flat at /api/attendance) — ownership is derived
// from the body-supplied inviteId's parent event, then gated through
// eventService.getById(), same shape as event-day/guest/invite. Attendance
// stays a genuine hard delete (no isArchived field) — that is intentional
// and untouched here.
export const attendanceService = {
    getAll: async (inviteId, requestingRole, tenantId) => {
        const invite = await inviteRepository.findById(inviteId);
        if (!invite)
            throw new HttpError(404, 'Invite not found');
        await eventService.getById(invite.eventId, requestingRole, tenantId);
        return attendanceRepository.findAll(inviteId);
    },
    getById: async (id, requestingRole, tenantId) => {
        const attendance = await attendanceRepository.findById(id);
        if (!attendance)
            throw new HttpError(404, 'Attendance record not found');
        await eventService.getById(attendance.invite.eventId, requestingRole, tenantId);
        return attendance;
    },
    create: async (inviteId, eventDayId, requestingRole, tenantId) => {
        const invite = await inviteRepository.findById(inviteId);
        if (!invite)
            throw new HttpError(404, 'Invite not found');
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
    delete: async (id, requestingRole, tenantId) => {
        await attendanceService.getById(id, requestingRole, tenantId);
        return attendanceRepository.delete(id);
    },
};
//# sourceMappingURL=attendance.service.js.map