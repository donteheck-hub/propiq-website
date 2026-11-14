export type Sport = 'NBA' | 'NFL';
export type Prop = { id: string; sport: Sport; player: string; market: string; marketKey: string; line: number; side: 'Over' | 'Under'; odds: number; bookmaker: string; event: string; commence: string; source: 'live' | 'manual' | 'demo' };
export type LogRow = { sport: Sport; player: string; marketKey: string; date: string; value: number; opponent?: string; venue?: 'home' | 'away' };
export const MARKETS: Record<Sport, Record<string, string>> = {
  NBA: { player_points: 'Points', player_rebounds: 'Rebounds', player_assists: 'Assists', player_threes: '3-Pointers', player_blocks: 'Blocks', player_steals: 'Steals', player_points_rebounds_assists: 'Pts + Reb + Ast' },
  NFL: { player_pass_yds: 'Passing Yards', player_rush_yds: 'Rushing Yards', player_reception_yds: 'Receiving Yards', player_receptions: 'Receptions', player_pass_tds: 'Passing TDs', player_rush_attempts: 'Rushing Attempts', player_pass_completions: 'Completions' }
};
export const normalize = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
// NBA seasons begin in October; NFL weekly observations carry their season year.
// An imported NBA date before October belongs to the season starting the previous year.
export function logSeason(row: Pick<LogRow, 'sport' | 'date'>): number | null {
  const match = /^(\d{4})(?:-(\d{2})-(\d{2})|-W\d{2})$/.exec(row.date);
  if (!match) return null;
  const year = Number(match[1]);
  if (row.sport === 'NFL') return year;
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? (month >= 10 ? year : year - 1) : null;
}
export function currentSeason(sport: Sport, today = new Date()): number {
  const year = today.getUTCFullYear();
  return sport === 'NBA' && today.getUTCMonth() < 9 ? year - 1 : year;
}
export function seasonLabel(sport: Sport, year: number): string {
  return sport === 'NBA' ? `${year}-${String((year + 1) % 100).padStart(2, '0')}` : String(year);
}
// Only infer venue from an explicit matchup marker; opponent-only strings are unknown.
export function gameVenue(row: LogRow): 'home' | 'away' | null {
  if (row.venue === 'home' || row.venue === 'away') return row.venue;
  const matchup = row.opponent || '';
  if (/\s@\s/.test(matchup)) return 'away';
  if (/\s(?:vs\.?|v\.)\s/i.test(matchup)) return 'home';
  return null;
}
export function gameOpponent(row: LogRow): string | null {
  const raw = (row.opponent || '').trim();
  if (!raw) return null;
  const matchup = raw.match(/\s(?:@|vs\.?|v\.)\s+(.+)$/i);
  return (matchup ? matchup[1] : raw).trim().toUpperCase() || null;
}
export function splitHistory(prop: Prop, games: LogRow[]) {
  const summarize = (rows: LogRow[]) => {
    const hits = rows.filter(g => prop.side === 'Over' ? g.value > prop.line : g.value < prop.line).length;
    const pushes = rows.filter(g => g.value === prop.line).length;
    return { games: rows.length, hits, pushes, pct: rows.length ? Math.round(100 * hits / rows.length) : null,
      average: rows.length ? rows.reduce((sum, row) => sum + row.value, 0) / rows.length : null };
  };
  const home = games.filter(g => gameVenue(g) === 'home');
  const away = games.filter(g => gameVenue(g) === 'away');
  const known = home.length + away.length;
  const opponents = [...new Set(games.map(gameOpponent).filter((x): x is string => !!x))].sort();
  return { home: summarize(home), away: summarize(away), unknownVenue: games.length - known, opponents, summarize };
}
export type HitRate = { hits: number; total: number; pushes: number; pct: number; complete: boolean };
export function analyze(prop: Prop, logs: LogRow[], season?: number) {
  const games = logs.filter(x => x.sport === prop.sport && normalize(x.player) === normalize(prop.player) && x.marketKey === prop.marketKey && Number.isFinite(x.value) && (season === undefined || logSeason(x) === season)).sort((a, b) => b.date.localeCompare(a.date));
  const hit = (n: number): HitRate | null => {
    const batch = games.slice(0, n);
    if (!batch.length) return null;
    const hits = batch.filter(g => prop.side === 'Over' ? g.value > prop.line : g.value < prop.line).length;
    const pushes = batch.filter(g => g.value === prop.line).length;
    // Maintain the existing definition: pushes count in the sample, not as hits.
    return { hits, total: batch.length, pushes, pct: Math.round(hits / batch.length * 100), complete: batch.length >= n };
  };
  const recent = games.slice(0, 10);
  const avg = recent.length ? recent.reduce((s, r) => s + r.value, 0) / recent.length : null;
  // Past hit frequency is NOT a validated future probability.
  return { games, avg, hit5: hit(5), hit10: hit(10), hit20: hit(20), season: hit(games.length || 1) };
}
export function implied(odds: number) { return odds < 0 ? Math.abs(odds) / (Math.abs(odds) + 100) : 100 / (odds + 100); }
export function parseCsv(content: string): LogRow[] {
  const lines = content.trim().split(/\r?\n/).filter(Boolean); if (lines.length < 2) return [];
  const split = (s: string) => { const out: string[] = []; let q = false, c = ''; for (let i = 0; i < s.length; i++) { if (s[i] === '"') { if (q && s[i + 1] === '"') { c += '"'; i++; } else q = !q; } else if (s[i] === ',' && !q) { out.push(c.trim()); c = ''; } else c += s[i]; } out.push(c.trim()); return out; };
  const headers = split(lines[0]).map(x => x.replace(/^\ufeff/, '').toLowerCase());
  const required = ['sport', 'player', 'marketkey', 'date', 'value'];
  if (required.some(k => !headers.includes(k))) throw Error('CSV needs columns: sport,player,marketKey,date,value (optional: opponent)');
  return lines.slice(1).map(line => { const cells = split(line), get = (k: string) => { const i = headers.indexOf(k); return i < 0 ? '' : cells[i] ?? ''; }; return { sport: get('sport').toUpperCase() as Sport, player: get('player'), marketKey: get('marketkey'), date: get('date'), value: Number(get('value')), opponent: get('opponent'), venue: (['home', 'h'].includes(get('venue').toLowerCase()) ? 'home' : ['away', 'a'].includes(get('venue').toLowerCase()) ? 'away' : undefined) as 'home' | 'away' | undefined }; }).filter(r => (r.sport === 'NBA' || r.sport === 'NFL') && !!r.player && !!r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && Number.isFinite(r.value) && !!MARKETS[r.sport][r.marketKey]);
}


// Optional, user-supplied team-level defensive data. Never derive league ranks from
// the player-history subset requested by the browser (it is not league-wide).
export type DefenseRow = {
  sport: Sport; season: number; team: string; marketKey: string;
  allowedPerGame: number; games: number; source: string;
};
export const TEAM_COUNTS: Record<Sport, number> = { NBA: 30, NFL: 32 };
export function parseDefenseCsv(content: string): DefenseRow[] {
  const lines = content.replace(/^\uFEFF/, '').trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw Error('CSV is empty. Include the header and team rows.');
  const parse = (line: string): string[] => {
    const cells: string[] = []; let token = ''; let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (quoted && line[i + 1] === '"') { token += '"'; i++; } else quoted = !quoted; }
      else if (c === ',' && !quoted) { cells.push(token.trim()); token = ''; }
      else token += c;
    }
    if (quoted) throw Error('Unclosed quoted CSV field.');
    cells.push(token.trim()); return cells;
  };
  const header = parse(lines[0]).map(x => x.toLowerCase());
  const fields = ['sport','season','team','marketkey','allowedpergame','games','source'];
  if (fields.some(f => !header.includes(f))) throw Error('Required columns: sport,season,team,marketKey,allowedPerGame,games,source');
  const out = new Map<string, DefenseRow>();
  for (const [index, line] of lines.slice(1).entries()) {
    const cells = parse(line);
    const get = (k: string) => cells[header.indexOf(k)] || '';
    const sport = get('sport').toUpperCase() as Sport;
    const season = Number(get('season'));
    const team = get('team').toUpperCase().trim();
    const marketKey = get('marketkey');
    const allowedPerGame = Number(get('allowedpergame'));
    const games = Number(get('games'));
    const source = get('source').trim();
    if (!(sport in MARKETS) || !MARKETS[sport]?.[marketKey] || !Number.isInteger(season) || season < 2000 || season > 2100 ||
      !/^[A-Z0-9 .'-]{2,45}$/.test(team) || !get('allowedpergame') || !Number.isFinite(allowedPerGame) || allowedPerGame < 0 ||
      !Number.isInteger(games) || games <= 0 || games > 100 || !source || source.length > 160) {
      throw Error(`Invalid defensive data on CSV line ${index + 2}. Check sport, season, team, market, numbers and source.`);
    }
    const key = `${sport}|${season}|${marketKey}|${normalize(team)}`;
    if (out.has(key)) throw Error(`Duplicate team/market/season on CSV line ${index + 2}.`);
    out.set(key, {sport,season,team,marketKey,allowedPerGame,games,source});
  }
  if (out.size > 6000) throw Error('Import limit is 6,000 rows.');
  return [...out.values()];
}
export function defenseContext(rows: DefenseRow[], sport: Sport, season: number, marketKey: string, team: string) {
  const eligible = rows.filter(r => r.sport === sport && r.season === season && r.marketKey === marketKey);
  const selected = eligible.find(r => normalize(r.team) === normalize(team));
  const expected = TEAM_COUNTS[sport];
  const completeLeague = new Set(eligible.map(r => normalize(r.team))).size === expected;
  const ordered = [...eligible].sort((a,b) => a.allowedPerGame - b.allowedPerGame);
  // Rank 1 = fewest allowed. Ties share a rank.
  const rank = selected && completeLeague ? 1 + ordered.filter(r => r.allowedPerGame < selected.allowedPerGame).length : null;
  return { selected, rank, coverage: eligible.length, expected, completeLeague };
}
