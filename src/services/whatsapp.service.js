const twilio = require('twilio');

const sendWhatsApp = async (phone, token) => {
  try {
    const client = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );

    const link = `${process.env.BASE_URL}/rsvp?token=${token}`;

    const message = `You're invited 🎉\nPlease RSVP here:\n${link}`;

    const response = await client.messages.create({
      body: message,
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: `whatsapp:${phone}`
    });
  } catch (error) {
    throw error;
  }
};

module.exports = {
  sendWhatsApp
};