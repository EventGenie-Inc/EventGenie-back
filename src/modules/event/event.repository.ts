import prisma from '../../shared/prisma/prisma.client.js';
import { type EventStatus } from '@prisma/client';
import { type CreateEventDto, type UpdateEventDto } from './event.types.js';

export const eventRepository = {

  findAll: (tenantId?: string, includeArchived = false) =>
    prisma.event.findMany({
      where: {
        ...(includeArchived ? {} : { isArchived: false }),
        ...(tenantId ? { tenantId } : {}),
      },
      include: { eventDays: { where: { isArchived: false } } },
      orderBy: { createdAt: 'desc' },
    }),

  findById: (id: string, includeArchived = false, tenantId?: string) =>
    prisma.event.findFirst({
      where: {
        id,
        ...(includeArchived ? {} : { isArchived: false }),
        ...(tenantId ? { tenantId } : {}),
      },
      include: {
        eventDays: { where: { isArchived: false } },
        memoryHub: true,
        tickets: { where: { isArchived: false } },
        rsvpFields: { where: { isArchived: false }, orderBy: { order: 'asc' } },
        program: {
          include: {
            programItems: { where: { isArchived: false }, orderBy: { order: 'asc' } },
          },
        },
      },
    }),

  countActive: (tenantId: string) =>
    prisma.event.count({ where: { tenantId, isArchived: false } }),

  // Accepted invites ≈ accepted guests: createWithInvite/bulkCreateWithInvites
  // (guest.repository.ts) create exactly one Invite per Guest, and
  // rsvp.service.ts's submit() flips that SAME invite's status rather than
  // creating a new one — so this never double-counts a guest who RSVP'd.
  countAcceptedInvitesForEvent: (eventId: string) =>
    prisma.invite.count({ where: { eventId, isArchived: false, status: 'ACCEPTED' } }),

  create: (tenantId: string, userId: string, data: CreateEventDto) =>
    prisma.event.create({
      data: {
        tenantId,
        createdByUserId: userId,
        name: data.name,
        // Optional fields must be null (not undefined) for exactOptionalPropertyTypes
        description: data.description ?? null,
        location: data.location,
        address: data.address ?? null,
        latitude: data.latitude ?? null,
        longitude: data.longitude ?? null,
        coverImageUrl: data.coverImageUrl ?? null,
        coverImagePublicId: data.coverImagePublicId ?? null,
        status: 'DRAFT',
        visibility: data.visibility ?? 'PRIVATE',
        ticketing: data.ticketing ?? 'FREE',
        invitationTemplate: data.invitationTemplate ?? null,
        invitationConfig: data.invitationConfig ?? null,
        rsvpDeadline: data.rsvpDeadline ? new Date(data.rsvpDeadline) : null,
        capacity: data.capacity ?? null,
        isArchived: false,
        createdBy: userId,
        updatedBy: userId,
      },
    }),

  update: (id: string, userId: string, data: UpdateEventDto) =>
    prisma.event.update({
      where: { id },
      data: {
        // Only include fields that are explicitly provided
        ...(data.name !== undefined && { name: data.name }),
        ...(data.description !== undefined && { description: data.description ?? null }),
        ...(data.location !== undefined && { location: data.location }),
        ...(data.address !== undefined && { address: data.address ?? null }),
        ...(data.latitude !== undefined && { latitude: data.latitude ?? null }),
        ...(data.longitude !== undefined && { longitude: data.longitude ?? null }),
        ...(data.coverImageUrl !== undefined && { coverImageUrl: data.coverImageUrl ?? null }),
        ...(data.coverImagePublicId !== undefined && { coverImagePublicId: data.coverImagePublicId ?? null }),
        ...(data.visibility !== undefined && { visibility: data.visibility }),
        ...(data.ticketing !== undefined && { ticketing: data.ticketing }),
        ...(data.invitationTemplate !== undefined && { invitationTemplate: data.invitationTemplate ?? null }),
        ...(data.invitationConfig !== undefined && { invitationConfig: data.invitationConfig ?? null }),
        ...(data.rsvpDeadline !== undefined && { rsvpDeadline: data.rsvpDeadline ? new Date(data.rsvpDeadline) : null }),
        ...(data.capacity !== undefined && { capacity: data.capacity ?? null }),
        updatedBy: userId,
      },
    }),

  archive: (id: string, userId: string) =>
    prisma.event.update({
      where: { id },
      data: { isArchived: true, updatedBy: userId },
    }),

  // SUPER_ADMIN support action — mirrors user.repository.ts/tenant.repository.ts's
  // reactivate exactly.
  reactivate: (id: string, userId: string) =>
    prisma.event.update({
      where: { id },
      data: { isArchived: false, updatedBy: userId },
    }),

  // The only writer of Event.status — publish() and cancel() in
  // event.service.ts are the sole callers. Kept separate from the
  // generic update() above (which no longer accepts a status field at
  // all) so a status transition can never be smuggled through a plain
  // PUT /api/events/:id alongside unrelated field edits.
  updateStatus: (id: string, userId: string, status: EventStatus) =>
    prisma.event.update({
      where: { id },
      data: { status, updatedBy: userId },
    }),
};