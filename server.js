/**
 * profilebackend — server.js
 * Rowan Elliss Portfolio Backend
 * Stack : Node.js · Express · MongoDB (Mongoose) · Telegraf · node-cron
 *
 * ─────────────────────────────────────────────────────────────────────
 *  .env / Render Environment Variables Setup Guide
 * ─────────────────────────────────────────────────────────────────────
 *  BOT_TOKEN           = Telegram Bot token from @BotFather
 *                        Example: 1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ
 *
 *  OWNER_TELEGRAM_ID   = Your personal Telegram numeric ID
 *  (or ADMIN_ID)         Get it from @userinfobot — open Telegram,
 *                        search @userinfobot, press START, it sends your ID.
 *                        Example: 123456789
 *                        ⚠️  Must be a NUMBER, NOT a username (@handle)
 *
 *  MONGO_URI           = MongoDB Atlas connection string
 *                        mongodb+srv://user:pass@cluster.mongodb.net/portfolio
 *
 *  ADMIN_TOKEN         = Random secret for /api/visitors and /api/stats
 *                        Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 *  SELF_URL            = Your Render service URL (for keep-alive cron)
 *                        Example: https://profilebackend-5mwr.onrender.com
 *
 *  PORT                = 3000 (Render sets this automatically)
 * ─────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();

const express      = require('express');
const mongoose     = require('mongoose');
const cors         = require('cors');
const cron         = require('node-cron');
const axios        = require('axios');
const { Telegraf } = require('telegraf');

const Visitor = require('./models/Visitor');

// ─── Validate critical env vars ────────────────────────────────────────
const BOT_TOKEN  = process.env.BOT_TOKEN;
const OWNER_ID   = process.env.OWNER_TELEGRAM_ID || process.env.ADMIN_ID; // support both names
const MONGO_URI  = process.env.MONGO_URI;
const ADMIN_TKN  = process.env.ADMIN_TOKEN;
const SELF_URL   = process.env.SELF_URL || 'https://profilebackend-5mwr.onrender.com';
const PORT       = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  console.error('❌ FATAL: BOT_TOKEN is not set in .env');
  process.exit(1);
}
if (!OWNER_ID) {
  console.error('❌ FATAL: OWNER_TELEGRAM_ID (or ADMIN_ID) is not set in .env');
  console.error('   Get your Telegram ID from @userinfobot — it looks like: 123456789');
  process.exit(1);
}
if (!MONGO_URI) {
  console.error('❌ FATAL: MONGO_URI is not set in .env');
  process.exit(1);
}

console.log(`✅ Config OK — Owner ID: ${OWNER_ID}`);

// ─── App ────────────────────────────────────────────────────────────────
const app = express();

// ─── CORS ───────────────────────────────────────────────────────────────
// Allow ALL origins (Vercel static site, Telegram WebApp, browsers, etc.)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));
app.options('*', cors()); // pre-flight for ALL routes

// ─── Body parser ────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Telegram Bot ───────────────────────────────────────────────────────
let bot;
try {
  bot = new Telegraf(BOT_TOKEN);

  bot.start(ctx =>
    ctx.reply('👋 Rowan Elliss Portfolio Bot is active!\n\nVisitor alerts will be sent here.')
  );

  // Graceful launch
  bot.launch().then(() => {
    console.log('🤖 Telegram bot launched successfully');
  }).catch(err => {
    console.error('❌ Telegram bot launch error:', err.message);
  });
} catch (err) {
  console.error('❌ Telegraf init error:', err.message);
}

// ─── MongoDB ────────────────────────────────────────────────────────────
mongoose
  .connect(MONGO_URI, {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 30000,
  })
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err.message));

// ═══════════════════════════════════════════════════════════════════════
//  HELPER — Send Telegram notification with retry
// ═══════════════════════════════════════════════════════════════════════
async function sendTelegramNotification(message) {
  if (!bot) throw new Error('Bot not initialized');

  // Retry up to 3 times
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await bot.telegram.sendMessage(OWNER_ID, message, { parse_mode: 'Markdown' });
      console.log(`[Notify] Message sent to owner (attempt ${attempt})`);
      return true;
    } catch (err) {
      console.warn(`[Notify] Attempt ${attempt} failed: ${err.message}`);
      if (attempt === 3) throw err;
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════════════

// Health check
app.get('/', (_req, res) => {
  res.json({
    status:  'ok',
    service: 'Rowan Elliss Portfolio API',
    ts:      new Date().toISOString(),
    ownerId: OWNER_ID ? '✅ configured' : '❌ missing',
    mongo:   mongoose.connection.readyState === 1 ? '✅ connected' : '⚠️ disconnected',
  });
});

// ── POST /api/track ──────────────────────────────────────────────────
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

    // Get client IP (supports proxies like Render / Vercel)
    const clientIp =
      (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      req.headers['x-real-ip'] ||
      req.socket?.remoteAddress ||
      null;

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
      ip:        clientIp,
    });

    // ② Build Telegram notification
    let msg = '';
    if (source === 'telegram' && tgId) {
      // Visitor from inside Telegram
      const fullName = [firstName, lastName].filter(Boolean).join(' ') || 'Unknown';
      const handle   = username ? `@${username}` : 'no username';
      msg = [
        '👁 *New Telegram Visitor!*',
        '',
        `📱 *Source:* Telegram WebApp`,
        `👤 *Name:* ${esc(fullName)}`,
        `🆔 *TG ID:* \`${tgId}\``,
        `🔗 *Username:* ${esc(handle)}`,
        `🌐 *Language:* ${langCode || 'unknown'}`,
        `🕐 *Time:* ${new Date().toUTCString()}`,
        `🔑 *DB ID:* \`${visitor._id}\``,
      ].join('\n');
    } else {
      // Direct browser visitor — always notify
      const agentShort = (userAgent || '').slice(0, 100);
      const isMobile   = /mobile|android|iphone|ipad/i.test(userAgent);
      const isChrome   = /chrome/i.test(userAgent) && !/edge/i.test(userAgent);
      const browserHint= isMobile ? '📱 Mobile' : '🖥️ Desktop';

      msg = [
        '👁 *New Direct Visitor!*',
        '',
        `🌐 *Source:* ${browserHint} Browser`,
        `🕐 *Time:* ${new Date().toUTCString()}`,
        `🌍 *IP:* ${esc(clientIp || 'unknown')}`,
        `📋 *Agent:* ${esc(agentShort)}`,
        `🔑 *DB ID:* \`${visitor._id}\``,
      ].join('\n');
    }

    // ③ Send notification (non-blocking for response)
    sendTelegramNotification(msg).catch(err => {
      console.error('[Notify] Failed to send notification:', err.message);
    });

    res.json({ success: true, id: visitor._id });
  } catch (err) {
    console.error('[/api/track]', err.message);
    // Always 200 — never break the frontend
    res.json({ success: false, error: err.message });
  }
});

// ── GET /api/visitors ────────────────────────────────────────────────
app.get('/api/visitors', async (req, res) => {
  if (req.query.token !== ADMIN_TKN)
    return res.status(401).json({ error: 'Unauthorized' });

  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const page  = Math.max(parseInt(req.query.page)  || 1, 1);
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

// ── GET /api/stats ───────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  if (req.query.token !== ADMIN_TKN)
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

// ── GET /api/test-notify ─────────────────────────────────────────────
// Test endpoint — call this to verify bot is working
app.get('/api/test-notify', async (req, res) => {
  if (req.query.token !== ADMIN_TKN)
    return res.status(401).json({ error: 'Unauthorized' });

  try {
    await sendTelegramNotification(
      `🧪 *Test Notification*\n\nBackend is working!\nOwner ID: \`${OWNER_ID}\`\nTime: ${new Date().toUTCString()}`
    );
    res.json({ success: true, message: 'Test notification sent!', ownerId: OWNER_ID });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, ownerId: OWNER_ID });
  }
});

// ═══════════════════════════════════════════════════════════════════════
//  CRON — Keep Render free tier awake (ping every 5 minutes)
// ═══════════════════════════════════════════════════════════════════════
cron.schedule('*/5 * * * *', async () => {
  try {
    await axios.get(`${SELF_URL}/`, { timeout: 10000 });
    console.log(`[Cron] Keep-alive ping OK — ${new Date().toISOString()}`);
  } catch (err) {
    console.warn('[Cron] Keep-alive ping failed:', err.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════════
function esc(s = '') {
  return String(s).replace(/[_*[\]()~`>#+=|{}.!\-]/g, '\\$&');
}

// ─── Start ──────────────────────────────────────────────────────────────
app.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT}`)
);

// ─── Graceful shutdown ──────────────────────────────────────────────────
process.once('SIGINT',  () => { if (bot) bot.stop('SIGINT');  process.exit(0); });
process.once('SIGTERM', () => { if (bot) bot.stop('SIGTERM'); process.exit(0); });
