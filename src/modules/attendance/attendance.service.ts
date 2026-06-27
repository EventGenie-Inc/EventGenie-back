import { attendanceRepository } from './attendance.repository.js';

export const attendanceService = {
  getAll: (inviteId: string) => attendanceRepository.findAll(inviteId),

  getById: async (id: string) => {
    const attendance = await attendanceRepository.findById(id);
    if (!attendance) throw new Error('Attendance record not found');
    return attendance;
  },

  create: (inviteId: string, eventDayId: string) =>
    attendanceRepository.create(inviteId, eventDayId),

  delete: async (id: string) => {
    await attendanceService.getById(id);
    return attendanceRepository.delete(id);
  },
};