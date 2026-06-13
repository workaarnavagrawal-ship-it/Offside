// ============================================================
// api-football.js — World Cup 2026 data integration
// Free tier: 100 req/day, header auth, GET-only.
// Docs: https://www.api-football.com/documentation-v3
// ============================================================

const API_BASE = 'https://v3.football.api-sports.io';
const API_KEY = process.env.API_FOOTBALL_KEY;
const WC_LEAGUE_ID = 1;     // FIFA World Cup
const WC_SEASON = 2026;

// Position label → points (your scheme: GK 10, DEF 3, MID 2, ATT 1)
const POSITION_POINTS = { Goalkeeper: 10, Defender: 3, Midfielder: 2, Attacker: 1 };

async function apiGet(path, params = {}) {
  if (!API_KEY) throw new Error('API_FOOTBALL_KEY env var is not set');
  const url = new URL(API_BASE + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url, { headers: { 'x-apisports-key': API_KEY } });
  const json = await res.json();

  if (json.errors && Object.keys(json.errors).length > 0) {
    throw new Error('API-Football error: ' + JSON.stringify(json.errors));
  }
  return json.response || [];
}

// ── Seed all WC squads into the players table ──────────────
// Call ONCE before the tournament (or after final squads lock).
// Costs ~1 request per team. Uses /players/squads.
async function seedSquads(supabase) {
  // 1. get all teams in the World Cup
  const teams = await apiGet('/teams', { league: WC_LEAGUE_ID, season: WC_SEASON });
  console.log(`Found ${teams.length} teams`);

  let inserted = 0;
  for (const t of teams) {
    const teamId = t.team.id;
    const teamName = t.team.name;

    // 2. get this team's squad (with positions)
    const squads = await apiGet('/players/squads', { team: teamId });
    const squad = squads[0]?.players || [];

    const rows = squad.map(p => ({
      api_player_id: p.id,
      name: p.name,
      team: teamName,
      position: p.position,
      points_value: POSITION_POINTS[p.position] ?? 1,
      photo: p.photo || null
    }));

    if (rows.length) {
      const { error } = await supabase
        .from('players')
        .upsert(rows, { onConflict: 'api_player_id' });
      if (error) console.error(`  ${teamName}: ${error.message}`);
      else { inserted += rows.length; console.log(`  ${teamName}: ${rows.length} players`); }
    }

    // gentle pacing to respect rate limits
    await new Promise(r => setTimeout(r, 300));
  }
  console.log(`✅ Seeded ${inserted} players`);
  return inserted;
}

// ── Fetch result + goalscorers for one fixture ─────────────
// Returns { home_score, away_score, finished, goals: [{api_player_id, name, own}] }
async function fetchFixtureResult(apiFixtureId) {
  const fixtures = await apiGet('/fixtures', { id: apiFixtureId });
  const fx = fixtures[0];
  if (!fx) return null;

  const finished = ['FT', 'AET', 'PEN'].includes(fx.fixture.status.short);
  const goals = [];

  if (finished) {
    const events = await apiGet('/fixtures/events', { fixture: apiFixtureId });
    for (const ev of events) {
      if (ev.type === 'Goal') {
        // exclude own goals — they don't count for the predicted scorer
        const isOwn = ev.detail === 'Own Goal';
        goals.push({
          api_player_id: ev.player.id,
          name: ev.player.name,
          own: isOwn
        });
      }
    }
  }

  return {
    home_score: fx.goals.home,
    away_score: fx.goals.away,
    finished,
    goals
  };
}

// ── Match API fixtures to your matches rows by team names ──
// Populates matches.external_id so scoring knows which API fixture to read.
async function linkFixtures(supabase) {
  const fixtures = await apiGet('/fixtures', { league: WC_LEAGUE_ID, season: WC_SEASON });
  const { data: matches } = await supabase.from('matches').select('id, home_team, away_team, external_id');

  let linked = 0;
  // Normalize names so small differences still match:
  // lowercase, trim, strip accents (Türkiye→turkiye), collapse spaces.
  const norm = s => (s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove accents
    .toLowerCase().trim().replace(/\s+/g, ' ');

  // Common name aliases (DB spelling → API spelling differences)
  const ALIAS = {
    'usa': 'united states',
    'turkey': 'turkiye',
    'south korea': 'korea republic',
    'ivory coast': "cote d'ivoire",
    'dr congo': 'congo dr',
    'czechia': 'czech republic'
  };
  const canon = s => { const n = norm(s); return ALIAS[n] || n; };

  for (const m of matches || []) {
    if (m.external_id) continue; // already linked
    const match = fixtures.find(fx =>
      canon(fx.teams.home.name) === canon(m.home_team) &&
      canon(fx.teams.away.name) === canon(m.away_team)
    );
    if (match) {
      await supabase.from('matches').update({ external_id: match.fixture.id }).eq('id', m.id);
      linked++;
    } else {
      console.log(`  ⚠️ no API match for: ${m.home_team} v ${m.away_team}`);
    }
  }
  console.log(`🔗 Linked ${linked} fixtures`);
  return linked;
}

module.exports = { seedSquads, fetchFixtureResult, linkFixtures, POSITION_POINTS };
