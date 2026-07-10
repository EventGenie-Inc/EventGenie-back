const mongoose = require('mongoose');

const rsvpSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true },
    surname: { type: String, required: true },

    status: {
      type: String,
      enum: ['accepted', 'declined'],
      default: 'accepted',
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Rsvp', rsvpSchema);