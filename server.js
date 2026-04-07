/**
 * profilebackend — server.js
 * Rowan Elliss Portfolio Backend
 * Stack : Node.js · Express · MongoDB (Mongoose) · Telegraf · node-cron
 */

require('dotenv').config();

const express     = require('express');
const mongoose    = require('mongoose');
const cors        = require('cors');
const cron        = require('node-cron');
const axios       = require('axios');
const { Telegraf } = require('telegraf');

const Visitor = require('./models/Visitor');

// ─── App ────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

// ─── CORS ────────────────────────────────────────────────────
// Allow ALL origins (Vercel static site, Telegram WebApp, etc.)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.options('*', cors()); // pre-flight for ALL routes

// ─── Body parser ─────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Telegram Bot ─────────────────────────────────────────────
const bot = new Telegraf(process.env.BOT_TOKEN);

bot.start(ctx =>
  ctx.reply('👋 Rowan Elliss Portfolio Bot is active!\n\nVisitor alerts will be sent here.')
);
bot.launch();
console.log('🤖 Telegram bot launched');

// ─── MongoDB ──────────────────────────────────────────────────
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err.message));

// ═══════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════

// Health check
app.get('/', (_req, res) => {
  res.json({
    status:  'ok',
    service: 'Rowan Elliss Portfolio API',
    ts:      new Date().toISOString(),
  });
});

// ── POST /api/track ──────────────────────────────────────────
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
      pageUrl   = '',
    } = req.body;

    // ① Save visitor to MongoDB
    const visitor = await Visitor.create({
      source,
      userAgent,
      tgId:      tgId      || null,
      firstName: firstName || null,
      lastName:  lastName  || null,
      username:  username  || null,
      langCode:  langCode  || null,
      pageUrl,
      visitedAt: timestamp ? new Date(timestamp) : new Date(),
      ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
          || req.socket?.remoteAddress
          || null,
    });

    // ② Build Telegram notification message
    let msg = '';
    if (source === 'telegram' && tgId) {
      const fullName = [firstName, lastName].filter(Boolean).join(' ') || 'Unknown';
      const handle   = username ? `@${username}` : 'no username';
      msg = [
        '👁 *New Telegram Visitor!*',
        '',
        `📱 *Source:* Telegram`,
        `👤 *Name:* ${esc(fullName)}`,
        `🆔 *ID:* \`${tgId}\``,
        `🔗 *Username:* ${esc(handle)}`,
        `🌐 *Language:* ${langCode || 'unknown'}`,
        `🕐 *Time:* ${new Date().toUTCString()}`,
        `🔑 *DB ID:* \`${visitor._id}\``,
      ].join('\n');
    } else {
      msg = [
        '👁 *New Direct Visitor!*',
        '',
        `🌐 *Source:* Browser / Direct`,
        `🕐 *Time:* ${new Date().toUTCString()}`,
        `📋 *Agent:* ${esc((userAgent || '').slice(0, 80))}`,
        `🔑 *DB ID:* \`${visitor._id}\``,
      ].join('\n');
    }

    // ③ Send alert to owner
    await bot.telegram.sendMessage(
      process.env.OWNER_TELEGRAM_ID,
      msg,
      { parse_mode: 'Markdown' }
    );

    res.json({ success: true, id: visitor._id });
  } catch (err) {
    console.error('[/api/track]', err.message);
    // Always 200 — never break the frontend
    res.json({ success: false, error: err.message });
  }
});

// ── GET /api/visitors ─────────────────────────────────────────
app.get('/api/visitors', async (req, res) => {
  if (req.query.token !== process.env.ADMIN_TOKEN)
    return res.status(401).json({ error: 'Unauthorized' });

  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const page  = Math.max(parseInt(req.query.page) || 1, 1);
    const skip  = (page - 1) * limit;

    const [visitors, total] = await Promise.all([
      Visitor.find().sort({ visitedAt: -1 }).skip(skip).limit(limit),
      Visitor.countDocuments(),
    ]);

    res.json({ total, page, limit, visitors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/stats ────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  if (req.query.token !== process.env.ADMIN_TOKEN)
    return res.status(401).json({ error: 'Unauthorized' });

  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [total, fromTg, fromDirect, daily] = await Promise.all([
      Visitor.countDocuments(),
      Visitor.countDocuments({ source: 'telegram' }),
      Visitor.countDocuments({ source: 'direct' }),
      Visitor.aggregate([
        { $match: { visitedAt: { $gte: sevenDaysAgo } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$visitedAt' } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
    ]);

    res.json({ total, fromTelegram: fromTg, fromDirect, daily });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  CRON — Keep Render free tier awake (ping every 5 minutes)
// ═══════════════════════════════════════════════════════════════
const SELF_URL = process.env.SELF_URL || `https://profilebackend-5mwr.onrender.com`;

cron.schedule('*/5 * * * *', async () => {
  try {
    await axios.get(`${SELF_URL}/`);
    console.log(`[Cron] Ping OK — ${new Date().toISOString()}`);
  } catch (err) {
    console.warn('[Cron] Ping failed:', err.message);
  }
});

// ═══════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════
function esc(s = '') {
  return s.replace(/[_*[\]()~`>#+=|{}.!\-]/g, '\\$&');
}

// ─── Start ────────────────────────────────────────────────────
app.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT}`)
);

// ─── Graceful shutdown ────────────────────────────────────────
process.once('SIGINT',  () => { bot.stop('SIGINT');  process.exit(0); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); process.exit(0); });
