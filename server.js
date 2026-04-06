/**
 * profilebackend — server.js
 * Rowan Elliss Portfolio Backend
 * Stack: Node.js · Express · MongoDB (Mongoose) · Telegraf (Telegram Bot)
 */

const express    = require('express');
const mongoose   = require('mongoose');
const cors       = require('cors');
const { Telegraf } = require('telegraf');
const Visitor    = require('./models/Visitor');

// ── App Init ────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──────────────────────────────────────────────────
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || '*',  // Your Vercel domain, e.g. https://rowanelliss.vercel.app
  ],
  methods: ['GET', 'POST'],
}));
app.use(express.json());

// ── Telegram Bot Init ───────────────────────────────────────────
const bot = new Telegraf(process.env.BOT_TOKEN);

// ── MongoDB Connect ─────────────────────────────────────────────
mongoose
  .connect(process.env.MONGO_URI, {
    useNewUrlParser:    true,
    useUnifiedTopology: true,
  })
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

// ═══════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════

// ── Health check ────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({ status: 'ok', message: 'Rowan Elliss Portfolio API' });
});

// ── POST /api/track ─────────────────────────────────────────────
/**
 * Receives visitor data from the frontend.
 * Saves to MongoDB and sends a Telegram alert to the owner.
 *
 * Body shape:
 *  { source, userAgent, timestamp, tgId?, firstName?, lastName?, username?, langCode? }
 */
app.post('/api/track', async (req, res) => {
  try {
    const {
      source    = 'direct',
      userAgent = '',
      timestamp,
      tgId,
      firstName = '',
      lastName  = '',
      username  = '',
      langCode  = '',
    } = req.body;

    // ── 1. Save to MongoDB ─────────────────────────────────────
    const visitor = await Visitor.create({
      source,
      userAgent,
      tgId:      tgId      || null,
      firstName: firstName || null,
      lastName:  lastName  || null,
      username:  username  || null,
      langCode:  langCode  || null,
      visitedAt: timestamp ? new Date(timestamp) : new Date(),
      ip:        req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
    });

    // ── 2. Build Telegram notification ────────────────────────
    let message = '';

    if (source === 'telegram' && tgId) {
      const fullName = [firstName, lastName].filter(Boolean).join(' ') || 'Unknown';
      const handle   = username ? `@${username}` : 'no username';
      message = [
        '👁️ *New Portfolio Visitor!*',
        '',
        `📱 *Source:* Telegram`,
        `👤 *Name:* ${escapeMarkdown(fullName)}`,
        `🆔 *Telegram ID:* \`${tgId}\``,
        `🔗 *Username:* ${escapeMarkdown(handle)}`,
        `🌐 *Language:* ${langCode || 'unknown'}`,
        `🕐 *Time:* ${new Date().toUTCString()}`,
        '',
        `🗄️ *DB Record ID:* \`${visitor._id}\``,
      ].join('\n');
    } else {
      message = [
        '👁️ *New Portfolio Visitor!*',
        '',
        `🌐 *Source:* Direct / Browser`,
        `🕐 *Time:* ${new Date().toUTCString()}`,
        `📋 *Agent:* ${escapeMarkdown(userAgent.slice(0, 80))}`,
        '',
        `🗄️ *DB Record ID:* \`${visitor._id}\``,
      ].join('\n');
    }

    // ── 3. Send to owner via Telegram Bot ─────────────────────
    await bot.telegram.sendMessage(
      process.env.OWNER_TELEGRAM_ID,
      message,
      { parse_mode: 'Markdown' }
    );

    res.json({ success: true, id: visitor._id });
  } catch (err) {
    console.error('[/api/track] Error:', err.message);
    // Still 200 — never break the frontend experience
    res.json({ success: false, error: err.message });
  }
});

// ── GET /api/visitors ──────────────────────────────────────────
/**
 * Returns visitor history (protected by simple token auth).
 * Usage: GET /api/visitors?token=YOUR_ADMIN_TOKEN&limit=50
 */
app.get('/api/visitors', async (req, res) => {
  const { token, limit = 50, page = 1 } = req.query;

  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const perPage = Math.min(parseInt(limit), 200);
    const skip    = (parseInt(page) - 1) * perPage;

    const [visitors, total] = await Promise.all([
      Visitor.find().sort({ visitedAt: -1 }).skip(skip).limit(perPage),
      Visitor.countDocuments(),
    ]);

    res.json({
      total,
      page:    parseInt(page),
      perPage,
      visitors,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/stats ─────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  const { token } = req.query;

  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const [total, fromTelegram, fromDirect] = await Promise.all([
      Visitor.countDocuments(),
      Visitor.countDocuments({ source: 'telegram' }),
      Visitor.countDocuments({ source: 'direct' }),
    ]);

    // Last 7 days per day
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const daily = await Visitor.aggregate([
      { $match: { visitedAt: { $gte: sevenDaysAgo } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$visitedAt' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    res.json({ total, fromTelegram, fromDirect, daily });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════

/** Escape Markdown special chars for Telegram */
function escapeMarkdown(str = '') {
  return str.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
}

// ── Telegram bot /start (optional) ────────────────────────────
bot.start(ctx => ctx.reply('👋 Rowan Elliss Portfolio Bot is running!'));

// ── Launch ─────────────────────────────────────────────────────
bot.launch();
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

// ── Graceful shutdown ──────────────────────────────────────────
process.once('SIGINT',  () => { bot.stop('SIGINT');  process.exit(0); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); process.exit(0); });
