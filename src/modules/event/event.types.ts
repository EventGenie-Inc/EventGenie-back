import { type EventStatus } from '@prisma/client';

export interface CreateEventDto {
  name: string;
  description?: string;
  location: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  coverImageUrl?: string;
}

export interface UpdateEventDto {
  name?: string;
  description?: string;
  location?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  coverImageUrl?: string;
  status?: EventStatus;
}