import { eventProgramRepository } from './event-program.repository.js';
import { type CreateEventProgramDto, type UpdateEventProgramDto } from './event-program.types.js';

export const eventProgramService = {

  getByEventId: async (eventId: string) => {
    const program = await eventProgramRepository.findByEventId(eventId);
    if (!program) throw new Error('Program not found for this event');
    return program;
  },

  getById: async (id: string) => {
    const program = await eventProgramRepository.findById(id);
    if (!program) throw new Error('Program not found');
    return program;
  },

  create: async (eventId: string, userId: string, data: CreateEventProgramDto) => {
    const existing = await eventProgramRepository.findByEventId(eventId);
    if (existing) throw new Error('A program already exists for this event');
    return eventProgramRepository.create(eventId, userId, data);
  },

  update: async (id: string, userId: string, data: UpdateEventProgramDto) => {
    await eventProgramService.getById(id);
    return eventProgramRepository.update(id, userId, data);
  },

  archive: async (id: string, userId: string) => {
    await eventProgramService.getById(id);
    return eventProgramRepository.archive(id, userId);
  },
};
