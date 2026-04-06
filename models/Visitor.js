/**
 * models/Visitor.js
 * MongoDB schema for portfolio visitor tracking
 */

const mongoose = require('mongoose');

const VisitorSchema = new mongoose.Schema(
  {
    // Where did the visitor come from?
    source: {
      type: String,
      enum: ['telegram', 'direct'],
      default: 'direct',
      index: true,
    },

    // Telegram user fields (null for direct visitors)
    tgId: {
      type: Number,
      default: null,
      index: true,
    },
    firstName: { type: String, default: null },
    lastName:  { type: String, default: null },
    username:  { type: String, default: null },
    langCode:  { type: String, default: null },

    // Browser info
    userAgent: { type: String, default: '' },
    ip:        { type: String, default: null },

    // Visit time (uses createdAt by default but explicit field for clarity)
    visitedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: true,   // adds createdAt + updatedAt
    collection: 'visitors',
  }
);

// ── Virtual: full name ───────────────────────────────────────
VisitorSchema.virtual('fullName').get(function () {
  return [this.firstName, this.lastName].filter(Boolean).join(' ') || 'Unknown';
});

// ── Static: recent visitors ──────────────────────────────────
VisitorSchema.statics.recent = function (limit = 20) {
  return this.find().sort({ visitedAt: -1 }).limit(limit);
};

// ── Static: count unique Telegram users ─────────────────────
VisitorSchema.statics.uniqueTelegramUsers = function () {
  return this.distinct('tgId', { tgId: { $ne: null } });
};

module.exports = mongoose.model('Visitor', VisitorSchema);
