const Invite = require('../models/invite.model');
const { generateToken } = require('../services/token.service');
const { sendSMS } = require('../services/whatsapp.service');

const VALID_DAYS = ['day1', 'day2', 'both'];

// ── Single invite ─────────────────────────────────────────────────────────────
exports.generateInvite = async (req, res) => {
  try {
    const { phoneNumber, invitedFor } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({ message: 'phoneNumber is required' });
    }

    if (!invitedFor || !VALID_DAYS.includes(invitedFor)) {
      return res.status(400).json({ message: 'invitedFor is required — must be day1, day2, or both' });
    }

    const token  = generateToken();
    const invite = await Invite.create({ token, phoneNumber, invitedFor });

    await sendSMS(phoneNumber, token, 'invite', invitedFor);

    res.json({ message: 'Invite created and sent', invite });

  } catch (err) {
    console.error('ERROR generating single invite:', err);
    res.status(500).json({ message: err.message });
  }
};

// ── Bulk invites ──────────────────────────────────────────────────────────────
exports.generateInvites = async (req, res) => {
  try {
    const { phoneNumbers, invitedFor } = req.body;

    if (!phoneNumbers || !phoneNumbers.length) {
      return res.status(400).json({ message: 'phoneNumbers array is required' });
    }

    if (!invitedFor || !VALID_DAYS.includes(invitedFor)) {
      return res.status(400).json({ message: 'invitedFor is required — must be day1, day2, or both' });
    }

    const invitesData = phoneNumbers.map((phone) => ({
      token: generateToken(),
      phoneNumber: phone,
      invitedFor,
    }));

    const invites = await Invite.insertMany(invitesData);

    const results = await Promise.allSettled(
      invites.map((invite) => sendSMS(invite.phoneNumber, invite.token, 'invite', invite.invitedFor))
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed    = results.filter((r) => r.status === 'rejected').length;

    res.json({
      message: `${invites.length} invites created — ${succeeded} sent, ${failed} failed`,
      invites,
    });

  } catch (err) {
    console.error('ERROR generating bulk invites:', err);
    res.status(500).json({ message: err.message });
  }
};

// ── Validate token ────────────────────────────────────────────────────────────
exports.validateToken = async (req, res) => {
  try {
    const { token } = req.params;

    const invite = await Invite.findOne({ token });

    if (!invite)     return res.json({ status: 'invalid' });
    if (invite.used) return res.json({ status: 'used' });

    if (invite.expiresAt && invite.expiresAt < new Date()) {
      return res.json({ status: 'expired' });
    }

    res.json({ status: 'valid', invitedFor: invite.invitedFor });

  } catch (err) {
    console.error('ERROR validating token:', err);
    res.status(500).json({ message: err.message });
  }
};

// ── Submit RSVP ───────────────────────────────────────────────────────────────
exports.submitRSVP = async (req, res) => {
  try {
    const { token, firstName, surname, attendance } = req.body;

    if (attendance && !VALID_DAYS.includes(attendance)) {
      return res.status(400).json({ message: 'attendance must be day1, day2, or both' });
    }

    const invite = await Invite.findOneAndUpdate(
      { token, used: false },
      {
        $set: {
          firstName,
          surname,
          attendance,
          used:   true,
          usedAt: new Date(),
          status: 'accepted',
        },
      },
      { new: true }
    );

    if (!invite) {
      return res.status(400).json({ message: 'Invalid or already used token' });
    }

    res.json({ message: 'RSVP successful' });

  } catch (err) {
    console.error('ERROR submitting RSVP:', err);
    res.status(500).json({ message: err.message });
  }
};

// ── Get all invites (optional status filter) ──────────────────────────────────
exports.getInvites = async (req, res) => {
  try {
    const { status } = req.query;
    const filter     = status ? { status } : {};

const invites = await Invite.find(filter).select(
  'firstName surname attendance invitedFor status phoneNumber'
);

    res.json(invites);

  } catch (err) {
    console.error('ERROR fetching invites:', err);
    res.status(500).json({ message: err.message });
  }
};

// ── Get invites by status ─────────────────────────────────────────────────────
exports.getByStatus = async (req, res) => {
  try {
    const { status } = req.params;
    const validStatuses = ['pending', 'accepted', 'declined'];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const invites = await Invite.find({ status }).select(
      'firstName surname attendance invitedFor status'
    );

    res.json(invites);

  } catch (err) {
    console.error('ERROR fetching invites by status:', err);
    res.status(500).json({ message: err.message });
  }
};

// ── Send edit link ────────────────────────────────────────────────────────────
exports.sendEditInvite = async (req, res) => {
  try {
    const { inviteId } = req.params;

    const invite = await Invite.findById(inviteId);

    if (!invite) {
      return res.status(404).json({ message: 'Invite not found' });
    }

    const crypto    = require('crypto');
    const editToken = crypto.randomBytes(8).toString('hex');

    invite.editToken          = editToken;
    invite.editTokenExpiresAt = new Date(Date.now() + 1000 * 60 * 60);

    await invite.save();

    await sendSMS(invite.phoneNumber, editToken, 'editing');

    res.json({ message: 'Edit link sent successfully' });

  } catch (err) {
    console.error('ERROR sending edit link:', err);
    res.status(500).json({ message: err.message });
  }
};

// ── Validate edit token ───────────────────────────────────────────────────────
exports.validateEditToken = async (req, res) => {
  try {
    const { token } = req.params;

    const invite = await Invite.findOne({ editToken: token });

    if (!invite) return res.json({ status: 'invalid' });

    if (invite.editTokenExpiresAt < new Date()) {
      return res.json({ status: 'expired' });
    }

    res.json({ status: 'valid', invite });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Update RSVP ───────────────────────────────────────────────────────────────
exports.updateRSVP = async (req, res) => {
  try {
    const { token, attendance } = req.body;

    if (attendance && !VALID_DAYS.includes(attendance)) {
      return res.status(400).json({ message: 'attendance must be day1, day2, or both' });
    }

    const invite = await Invite.findOne({ editToken: token });

    if (!invite) {
      return res.status(400).json({ message: 'Invalid token' });
    }

    if (invite.editTokenExpiresAt < new Date()) {
      return res.status(400).json({ message: 'Token expired' });
    }

    invite.attendance         = attendance;
    invite.editToken          = null;
    invite.editTokenExpiresAt = null;

    await invite.save();

    res.json({ message: 'RSVP updated successfully' });

  } catch (err) {
    console.error('ERROR updating RSVP:', err);
    res.status(500).json({ message: err.message });
  }
};

// ── Delete invite ─────────────────────────────────────────────────────────────
exports.deleteInvite = async (req, res) => {
  try {
    const { inviteId } = req.params;

    const invite = await Invite.findByIdAndDelete(inviteId);

    if (!invite) {
      return res.status(404).json({ message: 'Invite not found' });
    }

    res.json({ message: 'Invite deleted successfully' });

  } catch (err) {
    console.error('ERROR deleting invite:', err);
    res.status(500).json({ message: err.message });
  }
};