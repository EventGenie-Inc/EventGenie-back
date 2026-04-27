const Invite = require('../models/invite.model');
const { generateToken } = require('../services/token.service');
const { sendWhatsApp } = require('../services/whatsapp.service');
exports.generateInvite = async (req, res) => {
  try {
    const { phoneNumber } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({
        message: 'phoneNumber is required'
      });
    }

    const token = generateToken();

    const invite = await Invite.create({
      token,
      phoneNumber
    });

    res.json({
      message: 'Invite created successfully',
      invite
    });

  } catch (err) {
    console.error('ERROR generating single invite:', err);
    res.status(500).json({ message: err.message });
  }
};

exports.generateInvites = async (req, res) => {
  try {
    const { phoneNumbers } = req.body;

    if (!phoneNumbers || !phoneNumbers.length) {
      return res.status(400).json({
        message: 'phoneNumbers array is required'
      });
    }

    const invitesData = phoneNumbers.map((phone) => ({
      token: generateToken(),
      phoneNumber: phone
    }));

    const invites = await Invite.insertMany(invitesData);

    // batch WhatsApp sending
    await Promise.all(
      invites.map((invite) =>
        sendWhatsApp(invite.phoneNumber, invite.token)
      )
    );

    res.json({
      message: `${invites.length} invites sent`,
      invites
    });

  } catch (err) {
    console.error('ERROR generating bulk invites:', err);
    res.status(500).json({ message: err.message });
  }
};


exports.validateToken = async (req, res) => {
  try {
    const { token } = req.params;

    const invite = await Invite.findOne({ token });

    if (!invite) return res.json({ status: 'invalid' });
    if (invite.used) return res.json({ status: 'used' });

    if (invite.expiresAt && invite.expiresAt < new Date()) {
      return res.json({ status: 'expired' });
    }

    res.json({ status: 'valid' });
  } catch (err) {
    console.error('ERROR validating token:', err);
    res.status(500).json({ message: err.message });
  }
};


exports.submitRSVP = async (req, res) => {
  try {
    const { token, firstName, surname, attendance } = req.body;

    const invite = await Invite.findOneAndUpdate(
      { token, used: false },
      {
        $set: {
          firstName,
          surname,
          attendance,
          used: true,
          usedAt: new Date(),
          status: 'accepted'
        }
      },
      { new: true }
    );

    if (!invite) {
      return res.status(400).json({
        message: 'Invalid or already used token'
      });
    }

    res.json({ message: 'RSVP successful' });
  } catch (err) {
    console.error('ERROR submitting RSVP:', err);
    res.status(500).json({ message: err.message });
  }
};


exports.getInvites = async (req, res) => {
  try {
    const { status } = req.query;

    const filter = status ? { status } : {};

    const invites = await Invite.find(filter).select(
      'firstName surname attendance status'
    );

    res.json(invites);
  } catch (err) {
    console.error('ERROR fetching invites:', err);
    res.status(500).json({ message: err.message });
  }
};

exports.getByStatus = async (req, res) => {
  try {
    const { status } = req.params;

    const validStatuses = ['pending', 'accepted', 'declined'];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        message: 'Invalid status'
      });
    }

    const invites = await Invite.find({ status }).select(
      'firstName surname attendance status'
    );

    res.json(invites);
  } catch (err) {
    console.error('ERROR fetching invites by status:', err);
    res.status(500).json({ message: err.message });
  }
};

exports.sendEditInvite = async (req, res) => {
  try {
    const { inviteId } = req.params;

    const invite = await Invite.findById(inviteId);

    if (!invite) {
      return res.status(404).json({ message: 'Invite not found' });
    }

    const crypto = require('crypto');
    const editToken = crypto.randomBytes(8).toString('hex');

    invite.editToken = editToken;
    invite.editTokenExpiresAt = new Date(Date.now() + 1000 * 60 * 60); // hour

    await invite.save();

    const link = `${process.env.BASE_URL}/edit-rsvp?token=${editToken}`;

    await sendWhatsApp(invite.phoneNumber, editToken, 'editing');

    res.json({ message: 'Edit link sent successfully' });

  } catch (err) {
    console.error('ERROR sending edit link:', err);
    res.status(500).json({ message: err.message });
  }
};

exports.validateEditToken = async (req, res) => {
  try {
    const { token } = req.params;

    const invite = await Invite.findOne({ editToken: token });

    if (!invite) return res.json({ status: 'invalid' });

    if (invite.editTokenExpiresAt < new Date()) {
      return res.json({ status: 'expired' });
    }

    res.json({
      status: 'valid',
      invite
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.updateRSVP = async (req, res) => {
  try {
    const { token, attendance } = req.body;

    const invite = await Invite.findOne({ editToken: token });

    if (!invite) {
      return res.status(400).json({ message: 'Invalid token' });
    }

    if (invite.editTokenExpiresAt < new Date()) {
      return res.status(400).json({ message: 'Token expired' });
    }

    invite.attendance = attendance;

    invite.editToken = null;
    invite.editTokenExpiresAt = null;

    await invite.save();

    res.json({ message: 'RSVP updated successfully' });

  } catch (err) {
    console.error('ERROR updating RSVP:', err);
    res.status(500).json({ message: err.message });
  }
};

