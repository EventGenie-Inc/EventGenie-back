const twilio = require('twilio');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const DAY_LABEL = {
  day1: 'Day 1 only',
  day2: 'Day 2 only',
  both: 'both days',
};

/**
 * Send an SMS invitation or edit-link to a single guest.
 *
 * @param {string} phone       - E.164 format, e.g. +27821234567
 * @param {string} token       - invite or edit token
 * @param {string} action      - 'invite' | 'editing'
 * @param {string} invitedFor  - 'day1' | 'day2' | 'both' (required when action === 'invite')
 */
const sendSMS = async (phone, token, action = 'invite', invitedFor) => {
  try {
    let link;
    let message;

    if (action === 'editing') {
      link    = `https://eventgenie-75f90.web.app/rsvp/edit-rsvp?token=${token}`;
      message =
        `Hi! You can update your RSVP for Collen & Mapula's wedding here:\n${link}`;
    } else {
      const dayLabel = DAY_LABEL[invitedFor] ?? invitedFor;
      link           = `https://eventgenie-75f90.web.app/rsvp?token=${token}`;
      message =
        `You're invited to Collen & Mapula's wedding! 🎉\n` +
        `Your invitation is for ${dayLabel}.\n` +
        `Please RSVP using your personal link below:\n${link}`;
    }

    const response = await client.messages.create({
      body: message,
      from: process.env.TWILIO_SMS_FROM,
      to:   phone,
    });

    console.log(`SMS sent to ${phone} — SID: ${response.sid}`);

    return response;

  } catch (error) {
    console.error(`SMS error for ${phone}:`, error.message);
    throw error;
  }
};

module.exports = { sendSMS };