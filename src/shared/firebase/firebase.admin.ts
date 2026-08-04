import { initializeApp, getApps, cert, type App } from 'firebase-admin/app';

// ─────────────────────────────────────────
//  Firebase Admin SDK Singleton
//
//  Uses a singleton pattern to prevent
//  multiple app initialisations during
//  hot reloads in development.
// ─────────────────────────────────────────

const getFirebaseAdmin = (): App => {
  if (getApps().length > 0) {
    return getApps()[0]!;
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      'Missing Firebase Admin credentials. Ensure FIREBASE_PROJECT_ID, ' +
      'FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY are set in .env'
    );
  }

  return initializeApp({
    credential: cert({
      projectId,
      clientEmail,
      privateKey,
    }),
  });
};

export const firebaseAdmin = getFirebaseAdmin();