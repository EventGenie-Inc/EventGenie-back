import { attendanceRepository } from './attendance.repository.js';
export const attendanceService = {
    getAll: (inviteId) => attendanceRepository.findAll(inviteId),
    getById: async (id) => {
        const attendance = await attendanceRepository.findById(id);
        if (!attendance)
            throw new Error('Attendance record not found');
        return attendance;
    },
    create: (inviteId, eventDayId) => attendanceRepository.create(inviteId, eventDayId),
    delete: async (id) => {
        await attendanceService.getById(id);
        return attendanceRepository.delete(id);
    },
};
//# sourceMappingURL=attendance.service.js.map