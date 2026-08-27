import twilio from 'twilio';
import {} from './messaging.types.js';
// ─────────────────────────────────────────
//  SMS ENGINE
//
//  Knows Twilio and nothing else — no guest/invite/event/tier concepts.
//  Sends one SMS to one number and reports success or a human-readable
//  failure reason. This is what makes it reusable, unmodified, for
//  announcements/reminders/RSVP-confirmations later.
// ─────────────────────────────────────────
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const SMS_FROM = process.env.TWILIO_SMS_FROM;
// Twilio errors carry the reason in a numeric `.code`, not in `.message`
// (the message is often a generic wrapper). Mapped to short, actionable
// text; anything unmapped falls back to a generic-but-still-specific string
// rather than dumping the raw SDK error.
const TWILIO_ERROR_REASONS = {
    21211: 'The phone number is not formatted correctly',
    21614: 'This is not a valid mobile number and cannot receive SMS',
    21408: "SMS is not permitted to this number's region on this Twilio account",
    21610: 'This number has opted out of messages (unsubscribed)',
    21612: 'This number cannot be routed to any carrier',
    30003: "The recipient's phone is unreachable",
    30005: 'Unknown destination number',
    30006: 'Landline or unreachable carrier — cannot receive SMS',
};
export const sendSms = async (to, body) => {
    if (!SMS_FROM)
        throw new Error('TWILIO_SMS_FROM is not defined in .env');
    try {
        await client.messages.create({ to, from: SMS_FROM, body });
        return { ok: true };
    }
    catch (error) {
        const code = error.code;
        const reason = (code !== undefined && TWILIO_ERROR_REASONS[code])
            || `SMS delivery failed (Twilio error ${code ?? 'unknown'})`;
        return { ok: false, reason };
    }
};
//# sourceMappingURL=sms.engine.js.map