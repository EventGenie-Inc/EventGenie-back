const Rsvp = require('../models/rsvp.model');

// ── Submit RSVP (public, no token) ────────────────────────────────────────────
exports.submitRSVP = async (req, res) => {
  try {
    const { firstName, surname, status } = req.body;

    if (!firstName || !surname) {
      return res.status(400).json({ message: 'firstName and surname are required' });
    }

    const rsvp = await Rsvp.create({
      firstName,
      surname,
      ...(status && { status }),
    });

    res.json({ message: 'RSVP successful', rsvp });

  } catch (err) {
    console.error('ERROR submitting RSVP:', err);
    res.status(500).json({ message: err.message });
  }
};

// ── Get all RSVPs (optional status filter) ────────────────────────────────────
exports.getRSVPs = async (req, res) => {
  try {
    const { status } = req.query;
    const filter = status ? { status } : {};

    const rsvps = await Rsvp.find(filter).select('firstName surname status');

    res.json(rsvps);

  } catch (err) {
    console.error('ERROR fetching RSVPs:', err);
    res.status(500).json({ message: err.message });
  }
};

// ── Get RSVPs by status ────────────────────────────────────────────────────────
exports.getByStatus = async (req, res) => {
  try {
    const { status } = req.params;
    const validStatuses = ['accepted', 'declined'];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const rsvps = await Rsvp.find({ status }).select('firstName surname status');

    res.json(rsvps);

  } catch (err) {
    console.error('ERROR fetching RSVPs by status:', err);
    res.status(500).json({ message: err.message });
  }
};

// ── Delete RSVP ────────────────────────────────────────────────────────────────
exports.deleteRSVP = async (req, res) => {
  try {
    const { rsvpId } = req.params;

    const rsvp = await Rsvp.findByIdAndDelete(rsvpId);

    if (!rsvp) {
      return res.status(404).json({ message: 'RSVP not found' });
    }

    res.json({ message: 'RSVP deleted successfully' });

  } catch (err) {
    console.error('ERROR deleting RSVP:', err);
    res.status(500).json({ message: err.message });
  }
};