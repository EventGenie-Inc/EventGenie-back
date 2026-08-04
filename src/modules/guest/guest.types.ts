// guest.types.ts
export interface CreateGuestDto {
  firstName: string;
  surname: string;
  email?: string;
  phoneNumber?: string;
}
export interface UpdateGuestDto {
  firstName?: string;
  surname?: string;
  email?: string;
  phoneNumber?: string;
}