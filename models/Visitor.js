/**
 * models/Visitor.js
 */
const mongoose = require('mongoose');

const VisitorSchema = new mongoose.Schema({
  source:    { type: String, enum: ['telegram','direct'], default: 'direct', index: true },
  tgId:      { type: Number, default: null, index: true },
  firstName: { type: String, default: null },
  lastName:  { type: String, default: null },
  username:  { type: String, default: null },
  langCode:  { type: String, default: null },
  userAgent: { type: String, default: '' },
  ip:        { type: String, default: null },
  pageUrl:   { type: String, default: '' },
  visitedAt: { type: Date,   default: Date.now, index: true },
}, { timestamps: true, collection: 'visitors' });

VisitorSchema.virtual('fullName').get(function () {
  return [this.firstName, this.lastName].filter(Boolean).join(' ') || 'Unknown';
});

VisitorSchema.statics.recent = function (n = 20) {
  return this.find().sort({ visitedAt: -1 }).limit(n);
};

module.exports = mongoose.model('Visitor', VisitorSchema);
