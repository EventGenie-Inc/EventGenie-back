import { getAuth } from 'firebase-admin/auth';
import { firebaseAdmin } from './firebase.admin.js';

// ─────────────────────────────────────────
//  FIREBASE ACCOUNT STATUS UTILITY
//
//  Shared by the tenant and user suspension
//  flows. Postgres is the enforced source of
//  truth for access control — the auth
//  middleware checks isActive/isArchived on
//  every request — so a Firebase-side failure
//  here is a soft failure, not a blocking one.
//  The Postgres-side suspension must always
//  succeed even if Firebase is unreachable.
// ─────────────────────────────────────────

export const suspendFirebaseAccount = async (firebaseUid: string): Promise<void> => {
  try {
    await getAuth(firebaseAdmin).updateUser(firebaseUid, { disabled: true });
    await getAuth(firebaseAdmin).revokeRefreshTokens(firebaseUid);
  } catch (error) {
    console.error(`Failed to suspend Firebase account for uid ${firebaseUid}:`, error);
  }
};

export const reactivateFirebaseAccount = async (firebaseUid: string): Promise<void> => {
  try {
    await getAuth(firebaseAdmin).updateUser(firebaseUid, { disabled: false });
  } catch (error) {
    console.error(`Failed to reactivate Firebase account for uid ${firebaseUid}:`, error);
  }
};
