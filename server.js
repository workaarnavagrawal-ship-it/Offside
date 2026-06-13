// ============================================
// WC Predictor - Backend API (server.js)
// Deploy to: Railway / Render / Fly.io (free tier)
// ============================================

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const cron = require('node-cron');
const ws = require('ws');
const { fetchMatchResult, linkFixtures, findWorldCupLeagueId } = require('./highlightly');

// Normalize a player name for matching (case/accent/space-insensitive)
function normName(s) {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim().replace(/\s+/g, ' ');
}

const app = express();
app.use(express.json());
app.use(cors());

// ── Config (set these as env vars) ──────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MINI_APP_URL = process.env.MINI_APP_URL; // Your Vercel URL
const PORT = process.env.PORT || 3000;

// Provide `ws` as the WebSocket transport so @supabase/realtime-js can
// construct on Node < 22 (which lacks native WebSocket). We don't use
// realtime, but the client builds it at createClient() time regardless.
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  realtime: { transport: ws },
  auth: { persistSession: false, autoRefreshToken: false }
});
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

  // Get this user's scorer predictions (grouped by match)
  const { data: myScorers } = await supabase
    .from('scorer_predictions')
    .select('match_id, player_id, team, points_earned, players(name, position)')
    .eq('league_id', id)
    .eq('telegram_id', userId);

  const scorerMap = {};
  (myScorers || []).forEach(s => {
    if (!scorerMap[s.match_id]) scorerMap[s.match_id] = [];
    scorerMap[s.match_id].push(s);
  });

  res.json({
    league,
    members: members || [],
    matches: matches || [],
    myPredictions: predMap,
    myScorers: scorerMap,
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

// GET /api/players/:team — dropdown list for a team
app.get('/api/players/:team', requireMiniAppAuth, async (req, res) => {
  const { data } = await supabase
    .from('players')
    .select('id, name, position')
    .eq('team', req.params.team)
    .order('name', { ascending: true });
  res.json({ players: data || [] });
});

// POST /api/predict-scorer — pick a scorer (max 2 PER TEAM per match)
app.post('/api/predict-scorer', requireMiniAppAuth, async (req, res) => {
  const { league_id, match_id, player_id } = req.body;
  const userId = req.tgUser.id;

  // match must not have started
  const { data: match } = await supabase.from('matches').select().eq('id', match_id).single();
  if (!match) return res.status(404).json({ error: 'Match not found' });
  if (new Date(match.kickoff) <= new Date()) {
    return res.status(400).json({ error: 'Match has already started' });
  }

  // must be a league member
  const { data: member } = await supabase
    .from('league_members').select()
    .eq('league_id', league_id).eq('telegram_id', userId).single();
  if (!member) return res.status(403).json({ error: 'Not a league member' });

  // resolve the player + which team they belong to
  const { data: player } = await supabase
    .from('players').select('id, name, team').eq('id', player_id).single();
  if (!player) return res.status(404).json({ error: 'Player not found' });

  // player's team must be one of the two playing
  if (player.team !== match.home_team && player.team !== match.away_team) {
    return res.status(400).json({ error: 'Player is not in this match' });
  }

  // enforce max 2 picks for THIS team
  const { count } = await supabase
    .from('scorer_predictions')
    .select('*', { count: 'exact', head: true })
    .eq('league_id', league_id).eq('telegram_id', userId)
    .eq('match_id', match_id).eq('team', player.team);
  if ((count || 0) >= 2) {
    return res.status(400).json({ error: `Max 2 scorers for ${player.team}` });
  }

  const { data, error } = await supabase
    .from('scorer_predictions')
    .insert({ league_id, match_id, telegram_id: userId, player_id, team: player.team })
    .select().single();

  if (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'You already picked that player' });
    return res.status(500).json({ error: error.message });
  }
  res.json({ ok: true, prediction: data });
});

// POST /api/unpredict-scorer — remove a scorer pick (before kickoff)
app.post('/api/unpredict-scorer', requireMiniAppAuth, async (req, res) => {
  const { league_id, match_id, player_id } = req.body;
  const userId = req.tgUser.id;

  const { data: match } = await supabase.from('matches').select().eq('id', match_id).single();
  if (!match) return res.status(404).json({ error: 'Match not found' });
  if (new Date(match.kickoff) <= new Date()) {
    return res.status(400).json({ error: 'Match has already started' });
  }

  const { error } = await supabase
    .from('scorer_predictions').delete()
    .eq('league_id', league_id).eq('match_id', match_id)
    .eq('telegram_id', userId).eq('player_id', player_id);

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

// ════════════════════════════════════════════════════
// AUTO-SCORING (API-Football, scheduled)
// ════════════════════════════════════════════════════

// Score one match end-to-end from the API: result + goalscorers.
// Idempotent — safe to run repeatedly; only scores unscored predictions.
async function autoScoreMatch(match) {
  if (!match.external_id) return { skipped: 'no external_id' };

  const result = await fetchMatchResult(match.external_id);
  if (!result || !result.finished) return { skipped: 'not finished' };

  // 1. Save final score + mark finished (only if not already done)
  if (match.status !== 'finished') {
    await supabase.from('matches').update({
      home_score: result.home_score,
      away_score: result.away_score,
      status: 'finished'
    }).eq('id', match.id);
  }

  // 2. Store goalscorers by normalized name (own goals flagged)
  for (const g of result.goals) {
    await supabase.from('match_goals').upsert({
      match_id: match.id,
      player_name: g.name,
      player_name_norm: normName(g.name),
      is_own_goal: g.own
    }, { onConflict: 'match_id,player_name_norm' });
  }

  // 3. Run BOTH scoring functions (exact-score game + flat scorer game)
  await supabase.rpc('score_predictions', { p_match_id: match.id });
  await supabase.rpc('score_scorer_predictions', { p_match_id: match.id });

  // 4. Notify all members of every league that has this match in play
  const { data: leagues } = await supabase
    .from('predictions')
    .select('league_id')
    .eq('match_id', match.id);
  const leagueIds = [...new Set((leagues || []).map(l => l.league_id))];

  for (const leagueId of leagueIds) {
    const { data: members } = await supabase
      .from('league_members').select('telegram_id').eq('league_id', leagueId);
    const msg = `⚽ *Match Result*\n${match.home_flag} ${match.home_team} ${result.home_score}–${result.away_score} ${match.away_team} ${match.away_flag}\n\n📊 Scores updated! Check the leaderboard.`;
    // throttle to respect Telegram's ~30 msg/sec limit
    for (const m of members || []) {
      try {
        await bot.sendMessage(m.telegram_id, msg, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[
            { text: '🏆 View Leaderboard', web_app: { url: `${MINI_APP_URL}?league=${leagueId}&tab=leaderboard` } }
          ]]}
        });
      } catch (e) { /* blocked bot */ }
      await new Promise(r => setTimeout(r, 40));
    }
  }

  return { scored: true, score: `${result.home_score}-${result.away_score}`, goals: result.goals.length };
}

// Poll matches that have kicked off but aren't finished yet.
// Runs every 10 minutes — cheap on the API quota (1-2 calls per in-play match).
async function pollAndScore() {
  const nowIso = new Date().toISOString();
  const { data: due } = await supabase
    .from('matches')
    .select()
    .lte('kickoff', nowIso)          // already kicked off
    .neq('status', 'finished')        // not yet finalized
    .not('external_id', 'is', null);  // linked to an API fixture

  if (!due || due.length === 0) return;
  console.log(`[cron] checking ${due.length} in-play match(es)`);
  for (const m of due) {
    try {
      const r = await autoScoreMatch(m);
      if (r.scored) console.log(`[cron] scored ${m.home_team} v ${m.away_team} ${r.score}`);
    } catch (e) {
      console.error(`[cron] ${m.home_team} v ${m.away_team}:`, e.message);
    }
  }
}

// Schedule: every 10 minutes. Telegram + API quota friendly.
cron.schedule('*/10 * * * *', () => { pollAndScore().catch(console.error); });

// ── Admin/setup endpoints (run from a browser once) ────────
// Protected by a setup secret so randoms can't trigger them.
function checkSetupKey(req, res) {
  if (req.query.key !== process.env.SETUP_KEY) {
    res.status(403).json({ error: 'bad setup key' });
    return false;
  }
  return true;
}

// One-time check: find & print the World Cup league id in Highlightly
app.get('/setup/find-league', async (req, res) => {
  if (!checkSetupKey(req, res)) return;
  try { res.json({ ok: true, leagueId: await findWorldCupLeagueId() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// One-time (or re-run after adding matches): link matches → API fixtures
app.get('/setup/link-fixtures', async (req, res) => {
  if (!checkSetupKey(req, res)) return;
  try { res.json({ ok: true, linked: await linkFixtures(supabase) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Manual kick of the poller (handy for testing)
app.get('/setup/poll-now', async (req, res) => {
  if (!checkSetupKey(req, res)) return;
  try { await pollAndScore(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Health check
app.get('/', (req, res) => res.json({ ok: true, service: 'WC Predictor API' }));

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));