import prisma from '../../shared/prisma/prisma.client.js';
import { type CreateMemoryHubDto, type UpdateMemoryHubDto, type CreateMemoryItemDto, type UpdateMemoryItemDto } from './memory-hub.types.js';
import crypto from 'crypto';

export const memoryHubRepository = {

  // ── Memory Hub ────────────────────────────

  findByEventId: (eventId: string) =>
    prisma.memoryHub.findFirst({
      where: { eventId, isArchived: false },
      include: {
        memoryItems: {
          where: { isArchived: false },
          orderBy: { createdAt: 'desc' },
        },
      },
    }),

  findById: (id: string) =>
    prisma.memoryHub.findFirst({
      where: { id, isArchived: false },
      include: {
        memoryItems: {
          where: { isArchived: false },
          orderBy: { createdAt: 'desc' },
        },
      },
    }),

  findByShareToken: (shareToken: string) =>
    prisma.memoryHub.findFirst({
      where: { shareToken, isArchived: false },
      include: {
        // eventDays included so the nested event's status can be
        // resolved to its effective value (Task 2b) before this goes
        // out to a guest's browser — gating here still runs on
        // opensAt only (Memory Hub access is deliberately independent
        // of event status), this is presentation-only.
        event: { include: { eventDays: { where: { isArchived: false } } } },
        memoryItems: {
          where: { isArchived: false, isApproved: true },
          orderBy: { createdAt: 'desc' },
        },
      },
    }),

  create: (eventId: string, userId: string, data: CreateMemoryHubDto) =>
    prisma.memoryHub.create({
      data: {
        eventId,
        title: data.title ?? null,
        description: data.description ?? null,
        isPublic: false,
        shareToken: null,
        opensAt: data.opensAt ? new Date(data.opensAt) : null,
        isArchived: false,
        createdBy: userId,
        updatedBy: userId,
      },
    }),

  update: (id: string, userId: string, data: UpdateMemoryHubDto) =>
    prisma.memoryHub.update({
      where: { id },
      data: {
        ...(data.title !== undefined && { title: data.title ?? null }),
        ...(data.description !== undefined && { description: data.description ?? null }),
        ...(data.isPublic !== undefined && { isPublic: data.isPublic }),
        ...(data.opensAt !== undefined && { opensAt: data.opensAt ? new Date(data.opensAt) : null }),
        updatedBy: userId,
      },
    }),

  // Generate a public share token when hub is made public
  generateShareToken: (id: string, userId: string) =>
    prisma.memoryHub.update({
      where: { id },
      data: {
        isPublic: true,
        shareToken: crypto.randomBytes(24).toString('hex'),
        updatedBy: userId,
      },
    }),

  archive: (id: string, userId: string) =>
    prisma.memoryHub.update({
      where: { id },
      data: { isArchived: true, updatedBy: userId },
    }),

  // ── Memory Items ──────────────────────────

  findAllItems: (memoryHubId: string) =>
    prisma.memoryItem.findMany({
      where: { memoryHubId, isArchived: false },
      orderBy: { createdAt: 'desc' },
    }),

  findItemById: (id: string) =>
    prisma.memoryItem.findFirst({
      where: { id, isArchived: false },
    }),

  createItem: (memoryHubId: string, userId: string, data: CreateMemoryItemDto) =>
    prisma.memoryItem.create({
      data: {
        memoryHubId,
        mediaUrl: data.mediaUrl,
        mediaType: data.mediaType,
        caption: data.caption ?? null,
        uploadedByGuestId: data.uploadedByGuestId ?? null,
        uploadedByUserId: data.uploadedByUserId ?? null,
        isApproved: false,
        isArchived: false,
        createdBy: userId,
        updatedBy: userId,
      },
    }),

  updateItem: (id: string, userId: string, data: UpdateMemoryItemDto) =>
    prisma.memoryItem.update({
      where: { id },
      data: {
        ...(data.caption !== undefined && { caption: data.caption ?? null }),
        ...(data.isApproved !== undefined && { isApproved: data.isApproved }),
        updatedBy: userId,
      },
    }),

  archiveItem: (id: string, userId: string) =>
    prisma.memoryItem.update({
      where: { id },
      data: { isArchived: true, updatedBy: userId },
    }),
};