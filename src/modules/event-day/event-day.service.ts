import { eventDayRepository } from './event-day.repository.js';
import { type CreateEventDayDto, type UpdateEventDayDto } from './event-day.types.js';

export const eventDayService = {
  getAll: (eventId: string) => eventDayRepository.findAll(eventId),

  getById: async (id: string) => {
    const day = await eventDayRepository.findById(id);
    if (!day) throw new Error('Event day not found');
    return day;
  },

  create: (eventId: string, userId: string, data: CreateEventDayDto) =>
    eventDayRepository.create(eventId, userId, data),

  update: async (id: string, userId: string, data: UpdateEventDayDto) => {
    await eventDayService.getById(id);
    return eventDayRepository.update(id, userId, data);
  },

  archive: async (id: string, userId: string) => {
    await eventDayService.getById(id);
    return eventDayRepository.archive(id, userId);
  },
};