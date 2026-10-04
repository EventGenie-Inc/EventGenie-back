import { frontendUrl } from '../../shared/utils/frontend-url.util.js';

// ─────────────────────────────────────────
//  OUR OWN PASSWORD RESET LINK
//
//  Firebase's hosted action page (<project>.firebaseapp.com/__/auth/action)
//  and its email templates are not used: their settings are locked on our
//  projects. Firebase still MINTS the reset code
//  (generatePasswordResetLink); this file takes only the oobCode out of the
//  link Firebase returns and builds the link we email, on the frontend:
//
//    <FRONTEND_BASE_URL>/auth/action?mode=resetPassword&oobCode=<code>
//      &continueUrl=<FRONTEND_BASE_URL>/dashboard&lang=en
//
//  The frontend's /auth/action page verifies and applies the code with the
//  Firebase client SDK, then sends the user to continueUrl.
//
//  The oobCode is a live credential (whoever holds it can set the
//  password): it is never logged, and no error raised here contains it or
//  the link it came from.
// ─────────────────────────────────────────

export const PASSWORD_RESET_ACTION_PATH = '/auth/action';

// Where a user lands after resetting their password. The frontend has no
// standalone sign-in page (sign-in is a modal): /dashboard is guarded, so a
// signed-out visitor gets the sign-in modal there, and is returned to the
// dashboard once signed in.
export const PASSWORD_RESET_CONTINUE_PATH = '/dashboard';
export const passwordResetContinueUrl = (): string => frontendUrl(PASSWORD_RESET_CONTINUE_PATH);

// The settings passed to generatePasswordResetLink. handleCodeInApp is
// false, the web value: the code is handled by a web page, not a mobile app.
export const passwordResetActionCodeSettings = () => ({
  url: passwordResetContinueUrl(),
  handleCodeInApp: false,
});

export class PasswordResetLinkError extends Error {
  constructor() {
    // Deliberately says nothing about the link's contents.
    super('Firebase returned a password reset link with no oobCode; no reset email was sent.');
    this.name = 'PasswordResetLinkError';
  }
}

export const extractOobCode = (firebaseLink: string): string => {
  let code: string | null = null;
  try {
    code = new URL(firebaseLink).searchParams.get('oobCode');
  } catch {
    // Not a URL at all — handled below like a missing code.
  }
  if (!code?.trim()) throw new PasswordResetLinkError();
  return code;
};

// Every parameter URL-encoded (URLSearchParams), in this order.
export const buildPasswordResetLink = (oobCode: string): string => {
  const params = new URLSearchParams({
    mode: 'resetPassword',
    oobCode,
    continueUrl: passwordResetContinueUrl(),
    lang: 'en',
  });
  return frontendUrl(`${PASSWORD_RESET_ACTION_PATH}?${params.toString()}`);
};
