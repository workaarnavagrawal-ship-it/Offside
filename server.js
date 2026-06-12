// ============================================
// WC Predictor - Backend API (server.js)
// Deploy to: Railway / Render / Fly.io (free tier)
// ============================================

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(cors());

// ── Config (set these as env vars) ──────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MINI_APP_URL = process.env.MINI_APP_URL; // Your Vercel URL
const PORT = process.env.PORT || 3000;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const bot = new TelegramBot(BOT_TOKEN);

// ── In-memory conversation state ────────────────────
// Tracks admins mid-flow: { [userId]: { step, leagueName } }
const pendingCreation = {};

// ── Telegram Mini App auth validation ───────────────
function validateTelegramWebAppData(initData) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  return hash === expectedHash;
}

function getTelegramUser(initData) {
  const params = new URLSearchParams(initData);
  return JSON.parse(params.get('user'));
}

// ── Middleware: validate Mini App requests ───────────
function requireMiniAppAuth(req, res, next) {
  const initData = req.headers['x-telegram-init-data'];
  if (!initData) return res.status(401).json({ error: 'No auth' });

  if (!validateTelegramWebAppData(initData)) {
    return res.status(401).json({ error: 'Invalid Telegram auth' });
  }

  req.tgUser = getTelegramUser(initData);
  next();
}

// ════════════════════════════════════════════════════
// TELEGRAM BOT COMMANDS
// ════════════════════════════════════════════════════

// Set webhook (call once after deploy)
app.get('/set-webhook', async (req, res) => {
  const webhookUrl = `${MINI_APP_URL}/webhook`;
  await bot.setWebHook(webhookUrl);
  res.json({ ok: true, webhook: webhookUrl });
});

// Receive Telegram updates
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Respond fast
  const update = req.body;

  if (!update.message) return;
  const msg = update.message;
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text || '';

  // /start - welcome
  if (text.startsWith('/start')) {
    const joinCode = text.split(' ')[1]; // /start INVITE_CODE

    if (joinCode) {
      // Auto-join flow from invite link
      await handleJoinByCode(chatId, userId, msg.from, joinCode);
    } else {
      await bot.sendMessage(chatId,
        `🏆 *World Cup Predictor*\n\nPredict match scores and win the pot!\n\nCommands:\n/create — Create a new league\n/join CODE — Join with invite code\n/league — View your leagues`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '📋 Open App', web_app: { url: MINI_APP_URL } }
            ]]
          }
        }
      );
    }
  }

  // /create — step 1: ask for league name, then fee
  else if (text.startsWith('/create')) {
    const parts = text.split(' ');
    const leagueName = parts.slice(1).join(' ') || `${msg.from.first_name}'s League`;

    // Store pending state and ask for fee
    pendingCreation[userId] = { step: 'awaiting_fee', leagueName };

    await bot.sendMessage(chatId,
      `🏆 League name: *${leagueName}*\n\n💰 What's the entry fee (in ₹)? Reply with just the number e.g. *200*`,
      { parse_mode: 'Markdown' }
    );
  }

  // Fee reply — step 2: admin sends a number while pendingCreation is set
  else if (pendingCreation[userId]?.step === 'awaiting_fee') {
    const fee = parseInt(text.trim());

    if (isNaN(fee) || fee <= 0) {
      await bot.sendMessage(chatId, '❌ Please send a valid amount e.g. *200*', { parse_mode: 'Markdown' });
      return;
    }

    const { leagueName } = pendingCreation[userId];
    delete pendingCreation[userId]; // clear state

    const { data: league, error } = await supabase
      .from('leagues')
      .insert({
        name: leagueName,
        admin_telegram_id: userId,
        entry_fee: fee
      })
      .select()
      .single();

    if (error) {
      await bot.sendMessage(chatId, '❌ Failed to create league. Try again.');
      return;
    }

    // Admin is NOT added as a member — they run the league without being in the pot

    const inviteLink = `https://t.me/${(await bot.getMe()).username}?start=${league.invite_code}`;

    await bot.sendMessage(chatId,
      `✅ *League created!*\n\n🏆 ${league.name}\n💰 Entry fee: ₹${fee}\n🔑 Code: \`${league.invite_code}\`\n\nShare this link with friends:`,
      { parse_mode: 'Markdown' }
    );

    await bot.sendMessage(chatId, inviteLink);

    await bot.sendMessage(chatId, `Once everyone joins, open the app to make predictions:`, {
      reply_markup: {
        inline_keyboard: [[
          { text: '🏆 Open League', web_app: { url: `${MINI_APP_URL}?league=${league.id}` } }
        ]]
      }
    });
  }

  // /join CODE
  else if (text.startsWith('/join')) {
    const code = text.split(' ')[1];
    if (!code) {
      await bot.sendMessage(chatId, 'Usage: /join INVITE_CODE');
      return;
    }
    await handleJoinByCode(chatId, userId, msg.from, code);
  }

  // /league — list your leagues
  else if (text === '/league' || text === '/leagues') {
    const { data: memberships } = await supabase
      .from('league_members')
      .select('league_id, points, paid, leagues(name, entry_fee, invite_code, status)')
      .eq('telegram_id', userId);

    if (!memberships || memberships.length === 0) {
      await bot.sendMessage(chatId,
        '📋 You\'re not in any leagues yet.\n\nCreate one with /create or join with /join CODE'
      );
      return;
    }

    const buttons = memberships.map(m => ([{
      text: `🏆 ${m.leagues.name}`,
      web_app: { url: `${MINI_APP_URL}?league=${m.league_id}` }
    }]));

    await bot.sendMessage(chatId, `Your leagues (tap to open):`, {
      reply_markup: { inline_keyboard: buttons }
    });
  }
});

// Helper: join by invite code
async function handleJoinByCode(chatId, userId, from, code) {
  const { data: league } = await supabase
    .from('leagues')
    .select()
    .eq('invite_code', code)
    .single();

  if (!league) {
    await bot.sendMessage(chatId, '❌ Invalid invite code.');
    return;
  }

  // Check already member
  const { data: existing } = await supabase
    .from('league_members')
    .select()
    .eq('league_id', league.id)
    .eq('telegram_id', userId)
    .single();

  if (existing) {
    await bot.sendMessage(chatId, `You're already in *${league.name}*!`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '🏆 Open League', web_app: { url: `${process.env.MINI_APP_URL}?league=${league.id}` } }
        ]]
      }
    });
    return;
  }

  // Add member
  await supabase.from('league_members').insert({
    league_id: league.id,
    telegram_id: userId,
    username: from.username,
    display_name: from.first_name,
    paid: false
  });

  await bot.sendMessage(chatId,
    `✅ Joined *${league.name}*!\n\n💰 Entry fee: ₹${league.entry_fee}\n\nPay the admin to get marked as paid, then start predicting!`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '🎯 Make Predictions', web_app: { url: `${process.env.MINI_APP_URL}?league=${league.id}` } }
        ]]
      }
    }
  );
}

// ════════════════════════════════════════════════════
// MINI APP REST API
// ════════════════════════════════════════════════════

// GET /api/league/:id — full league data
app.get('/api/league/:id', requireMiniAppAuth, async (req, res) => {
  const { id } = req.params;
  const userId = req.tgUser.id;

  const [{ data: league }, { data: members }, { data: matches }] = await Promise.all([
    supabase.from('leagues').select().eq('id', id).single(),
    supabase.from('league_members')
      .select('telegram_id, display_name, username, points, paid')
      .eq('league_id', id)
      .order('points', { ascending: false }),
    supabase.from('matches')
      .select()
      .order('kickoff', { ascending: true })
  ]);

  if (!league) return res.status(404).json({ error: 'League not found' });

  // Get this user's predictions
  const { data: myPredictions } = await supabase
    .from('predictions')
    .select('match_id, home_score, away_score, points_earned')
    .eq('league_id', id)
    .eq('telegram_id', userId);

  const predMap = {};
  (myPredictions || []).forEach(p => { predMap[p.match_id] = p; });

  res.json({
    league,
    members: members || [],
    matches: matches || [],
    myPredictions: predMap,
    isAdmin: league.admin_telegram_id == userId,
    isMember: (members || []).some(m => m.telegram_id == userId),
    myPoints: (members || []).find(m => m.telegram_id == userId)?.points || 0
  });
});

// POST /api/predict — submit or update a prediction
app.post('/api/predict', requireMiniAppAuth, async (req, res) => {
  const { league_id, match_id, home_score, away_score } = req.body;
  const userId = req.tgUser.id;

  // Validate match hasn't started
  const { data: match } = await supabase.from('matches').select().eq('id', match_id).single();
  if (!match) return res.status(404).json({ error: 'Match not found' });
  if (new Date(match.kickoff) <= new Date()) {
    return res.status(400).json({ error: 'Match has already started' });
  }

  // Validate member
  const { data: member } = await supabase
    .from('league_members')
    .select()
    .eq('league_id', league_id)
    .eq('telegram_id', userId)
    .single();

  if (!member) return res.status(403).json({ error: 'Not a league member' });

  // Upsert prediction
  const { data, error } = await supabase
    .from('predictions')
    .upsert({
      league_id,
      match_id,
      telegram_id: userId,
      home_score: parseInt(home_score),
      away_score: parseInt(away_score)
    }, { onConflict: 'league_id,telegram_id,match_id' })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, prediction: data });
});

// POST /api/unpredict — remove a prediction (only before kickoff)
app.post('/api/unpredict', requireMiniAppAuth, async (req, res) => {
  const { league_id, match_id } = req.body;
  const userId = req.tgUser.id;

  // Can't unsave once the match has started
  const { data: match } = await supabase.from('matches').select().eq('id', match_id).single();
  if (!match) return res.status(404).json({ error: 'Match not found' });
  if (new Date(match.kickoff) <= new Date()) {
    return res.status(400).json({ error: 'Match has already started' });
  }

  const { error } = await supabase
    .from('predictions')
    .delete()
    .eq('league_id', league_id)
    .eq('match_id', match_id)
    .eq('telegram_id', userId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// POST /api/admin/mark-paid — admin marks a member as paid
app.post('/api/admin/mark-paid', requireMiniAppAuth, async (req, res) => {
  const { league_id, member_telegram_id } = req.body;
  const adminId = req.tgUser.id;

  const { data: league } = await supabase.from('leagues').select().eq('id', league_id).single();
  if (!league || league.admin_telegram_id != adminId) {
    return res.status(403).json({ error: 'Not the admin' });
  }

  await supabase
    .from('league_members')
    .update({ paid: true })
    .eq('league_id', league_id)
    .eq('telegram_id', member_telegram_id);

  // Recount from paid members to avoid race conditions
  const { count: paidCount } = await supabase
    .from('league_members')
    .select('*', { count: 'exact', head: true })
    .eq('league_id', league_id)
    .eq('paid', true);

  await supabase
    .from('leagues')
    .update({ pot: (paidCount || 0) * league.entry_fee })
    .eq('id', league_id);

  res.json({ ok: true });
});

// POST /api/admin/score-match — manually trigger scoring
app.post('/api/admin/score-match', requireMiniAppAuth, async (req, res) => {
  const { league_id, match_id, home_score, away_score } = req.body;
  const adminId = req.tgUser.id;

  const { data: league } = await supabase.from('leagues').select().eq('id', league_id).single();
  if (!league || league.admin_telegram_id != adminId) {
    return res.status(403).json({ error: 'Not the admin' });
  }

  // Update match result
  await supabase.from('matches').update({
    home_score,
    away_score,
    status: 'finished'
  }).eq('id', match_id);

  // Run scoring function
  await supabase.rpc('score_predictions', { p_match_id: match_id });

  // Notify league members via bot
  const { data: members } = await supabase
    .from('league_members')
    .select('telegram_id')
    .eq('league_id', league_id);

  const { data: match } = await supabase.from('matches').select().eq('id', match_id).single();
  const msg = `⚽ *Match Result*\n${match.home_flag} ${match.home_team} ${home_score}–${away_score} ${match.away_team} ${match.away_flag}\n\n📊 Scores updated! Check the leaderboard.`;

  for (const m of members || []) {
    try {
      await bot.sendMessage(m.telegram_id, msg, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '🏆 View Leaderboard', web_app: { url: `${MINI_APP_URL}?league=${league_id}&tab=leaderboard` } }
          ]]
        }
      });
    } catch (e) { /* user may have blocked bot */ }
  }

  res.json({ ok: true });
});

// Health check
app.get('/', (req, res) => res.json({ ok: true, service: 'WC Predictor API' }));

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));