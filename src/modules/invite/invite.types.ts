import { type InviteStatus, type DeliveryMethod } from '@prisma/client';

export interface CreateInviteDto {
  guestId: string;
  deliveryMethod: DeliveryMethod;
  expiresAt?: string;
  invitedDayIds: string[];
}
export interface UpdateInviteDto {
  status?: InviteStatus;
  deliveryMethod?: DeliveryMethod;
  expiresAt?: string;
}