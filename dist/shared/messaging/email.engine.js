import { Resend } from 'resend';
import {} from './messaging.types.js';
// ─────────────────────────────────────────
//  EMAIL ENGINE
//
//  Knows Resend and nothing else — no guest/invite/event/tier concepts.
//  Sends one email to one address and reports success or a human-readable
//  failure reason.
// ─────────────────────────────────────────
const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL ?? 'onboarding@resend.dev';
export const sendEmail = async (to, subject, html) => {
    try {
        const { error } = await resend.emails.send({ from: FROM_EMAIL, to, subject, html });
        if (error)
            return { ok: false, reason: error.message ?? 'Email delivery failed' };
        return { ok: true };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Email delivery failed';
        return { ok: false, reason: message };
    }
};
// Reusable brand shell — matches the existing OTP / password-reset email
// styling in auth.service.ts exactly (same colors, width, font) so every
// EventGenie email looks like one system.
export const renderBrandEmailShell = (heading, bodyHtml) => `
  <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
    <h2 style="color: #1A1A2E;">${heading}</h2>
    ${bodyHtml}
  </div>
`;
//# sourceMappingURL=email.engine.js.map