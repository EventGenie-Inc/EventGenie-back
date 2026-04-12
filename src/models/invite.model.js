const mongoose = require('mongoose');

const inviteSchema = new mongoose.Schema(
  {
    token: { type: String, required: true, unique: true },
    phoneNumber: String,

    status: {
      type: String,
      enum: ['pending', 'accepted', 'declined'],
      default: 'pending'
    },

    used: { type: Boolean, default: false },
    usedAt: Date,
    expiresAt: Date,

    firstName: String,
    surname: String,

    attendance: {
      type: String,
      enum: ['day1', 'day2', 'both']
    },

    editToken: String,
    editTokenExpiresAt: Date
  },
  { timestamps: true }
);
module.exports = mongoose.model('Invite', inviteSchema);