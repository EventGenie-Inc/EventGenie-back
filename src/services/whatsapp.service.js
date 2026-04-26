const twilio = require('twilio');

const sendWhatsApp = async (phone, token, action = 'invite') => {
  try {
    const client = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );

    const baseUrl = process.env.BASE_URL;

    let link = `https://eventgenie-75f90.web.app/rsvp?token=${token}`;
    let message = `You're invited 🎉\nPlease RSVP here:\n${link}`;

    if (action === 'editing') {
      link = `https://eventgenie-75f90.web.app/rsvp/edit-rsvp?token=${token}`;
      message = `Update your RSVP ✏️\nPlease edit your response here:\n${link}`;
    }

    const response = await client.messages.create({
      body: message,
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: `whatsapp:${phone}`,
      mediaUrl: [
        'https://eventgenie-75f90.web.app/invite.png'
      ]
    });

  } catch (error) {
    console.error('WhatsApp error:', error.message);
    throw error;
  }
};

module.exports = {
  sendWhatsApp
};