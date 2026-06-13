// ============================================================
// highlightly.js — World Cup 2026 data via Highlightly
// Free Basic tier: 100 req/day. Header auth, GET-only.
// Docs: https://highlightly.net/football-api/documentation/
//
// We use Highlightly for:
//   • final scores  (GET /matches)
//   • goalscorers   (GET /events/{matchId})  — flat scorer points
// Player positions are NOT used (flat points model), so no squad seeding.
// ============================================================

const API_BASE = 'https://soccer.highlightly.net';
const API_KEY = process.env.HIGHLIGHTLY_KEY;
const WC_SEASON = 2026;

async function apiGet(path, params = {}) {
  if (!API_KEY) throw new Error('HIGHLIGHTLY_KEY env var is not set');
  const url = new URL(API_BASE + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url, { headers: { 'x-rapidapi-key': API_KEY } });
  const json = await res.json();

  if (res.status >= 400) {
    throw new Error(`Highlightly ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  }
  // List endpoints wrap in { data: [...] }; single-resource endpoints return arrays/objects.
  return json;
}

// ── Find the World Cup league id (run once; cache the number) ──
async function findWorldCupLeagueId() {
  const json = await apiGet('/leagues', { leagueName: 'World Cup', season: WC_SEASON });
  const list = json.data || json;
  // Prefer the FIFA World Cup (men's) entry
  const wc = (list || []).find(l => /world cup/i.test(l.name) && !/women/i.test(l.name)) || (list || [])[0];
  if (!wc) throw new Error('Could not find World Cup league in Highlightly');
  console.log(`World Cup league id = ${wc.id} (${wc.name})`);
  return wc.id;
}

// ── Fetch all WC matches (for linking) ─────────────────────
async function fetchAllMatches(leagueId) {
  const out = [];
  let offset = 0;
  for (let i = 0; i < 6; i++) { // up to 6 pages of 100
    const json = await apiGet('/matches', { leagueId, season: WC_SEASON, limit: 100, offset });
    const batch = json.data || json || [];
    out.push(...batch);
    if (batch.length < 100) break;
    offset += 100;
  }
  return out;
}

// ── Normalize one match's status into finished + score ─────
function parseMatchStatus(m) {
  // Highlightly match state field name can vary; check the common ones.
  const stateRaw = (m.state && (m.state.description || m.state.clock || m.state.score)) || m.status || '';
  const desc = JSON.stringify(stateRaw).toLowerCase();
  const finished = /finished|full.?time|ended|\bft\b|after.?extra|penalties/.test(desc) ||
                   (m.state && m.state.description && /finished/i.test(m.state.description));

  // score can live in several shapes; try the common ones
  let home = null, away = null;
  if (m.state && m.state.score && m.state.score.current) {
    const parts = String(m.state.score.current).split('-').map(s => parseInt(s.trim()));
    if (parts.length === 2) { home = parts[0]; away = parts[1]; }
  }
  if (home === null && typeof m.homeScore === 'number') { home = m.homeScore; away = m.awayScore; }
  if (home === null && m.goals) { home = m.goals.home; away = m.goals.away; }

  return { finished, home_score: home, away_score: away };
}

// ── Fetch result + goalscorers for one match ───────────────
// Returns { finished, home_score, away_score, goals:[{name, own}] }
async function fetchMatchResult(apiMatchId) {
  // 1. the match record (score + status)
  const matchJson = await apiGet('/matches/' + apiMatchId);
  const m = Array.isArray(matchJson) ? matchJson[0] : (matchJson.data ? matchJson.data[0] : matchJson);
  if (!m) return null;

  const status = parseMatchStatus(m);
  const goals = [];

  if (status.finished) {
    // 2. live events for goalscorers
    let events = [];
    try {
      const evJson = await apiGet('/events/' + apiMatchId);
      events = Array.isArray(evJson) ? evJson : (evJson.data || evJson.events || []);
    } catch (e) {
      console.error(`  events fetch failed for match ${apiMatchId}: ${e.message}`);
    }

    for (const ev of events) {
      // Be liberal about field names across the API's event shape.
      const type = (ev.type || ev.eventType || '').toString().toLowerCase();
      if (type.includes('goal') || type.includes('penalty')) {
        const detail = (ev.detail || ev.subType || ev.description || '').toString().toLowerCase();
        const isOwn = detail.includes('own');
        const playerName = ev.player || ev.playerName || (ev.player && ev.player.name) || ev.assist || '';
        if (playerName) goals.push({ name: String(playerName), own: isOwn });
      }
    }
  }

  return { finished: status.finished, home_score: status.home_score, away_score: status.away_score, goals };
}

// ── Link our matches rows → Highlightly match ids ──────────
async function linkFixtures(supabase) {
  const leagueId = await findWorldCupLeagueId();
  const fixtures = await fetchAllMatches(leagueId);
  const { data: matches } = await supabase.from('matches').select('id, home_team, away_team, external_id');

  // normalize names (case/accents/aliases) for reliable matching
  const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
  const ALIAS = {
    'usa': 'united states', 'turkey': 'turkiye', 'south korea': 'korea republic',
    'ivory coast': "cote d'ivoire", 'dr congo': 'congo dr', 'czechia': 'czech republic'
  };
  const canon = s => { const n = norm(s); return ALIAS[n] || n; };
  const teamName = t => (t && (t.name || t)) || '';

  let linked = 0;
  for (const m of matches || []) {
    if (m.external_id) continue;
    const fx = fixtures.find(f =>
      canon(teamName(f.homeTeam || f.home)) === canon(m.home_team) &&
      canon(teamName(f.awayTeam || f.away)) === canon(m.away_team)
    );
    if (fx) {
      await supabase.from('matches').update({ external_id: fx.id }).eq('id', m.id);
      linked++;
    } else {
      console.log(`  ⚠️ no Highlightly match for: ${m.home_team} v ${m.away_team}`);
    }
  }
  console.log(`🔗 Linked ${linked} fixtures`);
  return linked;
}

module.exports = { fetchMatchResult, linkFixtures, findWorldCupLeagueId };