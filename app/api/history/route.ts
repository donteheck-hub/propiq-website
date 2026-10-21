import { NextRequest, NextResponse } from 'next/server';
import type { LogRow, Sport } from '../../../lib/props';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type CsvRow = Record<string, string>;
type HistoryResult = {
  rows: LogRow[];
  source: string;
  season: number | null;
  updatedAt: string;
  message: string;
  diagnostics: string[];
};

const TTL = 6 * 60 * 60 * 1000;
const cache: Partial<Record<Sport, { until: number; payload: HistoryResult }>> = {};

function parseCSV(content: string): CsvRow[] {
  const records: string[][] = [];
  let current: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === '"') {
      if (quoted && content[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      current.push(cell); cell = '';
    } else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && content[i + 1] === '\n') i++;
      current.push(cell); cell = '';
      if (current.some(value => value.trim())) records.push(current);
      current = [];
    } else {
      cell += ch;
    }
  }
  if (cell || current.length) { current.push(cell); records.push(current); }
  if (!records.length) return [];
  const headers = records[0].map(h => h.trim().toLowerCase().replace(/^\ufeff/, ''));
  return records.slice(1).map(fields => Object.fromEntries(
    headers.map((header, i) => [header, (fields[i] ?? '').trim()])
  ));
}

async function download(url: string): Promise<{ rows: CsvRow[] | null; status: string }> {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
      cache: 'no-store'
    });
    if (!response.ok) return { rows: null, status: `HTTP ${response.status}` };
    const length = Number(response.headers.get('content-length') || 0);
    if (length > 32 * 1024 * 1024) return { rows: null, status: 'File exceeds 32MB limit' };
    const text = await response.text();
    if (text.length > 32 * 1024 * 1024 || !text.includes(',')) {
      return { rows: null, status: 'Not a supported CSV or file too large' };
    }
    const rows = parseCSV(text);
    return { rows, status: `${rows.length} CSV records` };
  } catch (error) {
    return { rows: null, status: error instanceof Error ? error.message : 'Download failed' };
  }
}

function numeric(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function pushStat(
  output: LogRow[], sport: Sport, player: string, marketKey: string,
  date: string, value: number | null, opponent: string
) {
  if (value === null || !player || !date) return;
  output.push({ sport, player: player.trim(), marketKey, date, value, opponent });
}

function nbaRows(input: CsvRow[]): LogRow[] {
  const output: LogRow[] = [];
  for (const row of input) {
    const player = row.player_name || row.player_display_name || row.player ||
      [row.first_name, row.family_name].filter(Boolean).join(' ');
    const date = (row.game_date || row.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const opponent = row.matchup || row.opponent || '';
    const pts = numeric(row.pts);
    const reb = numeric(row.reb);
    const ast = numeric(row.ast);
    pushStat(output, 'NBA', player, 'player_points', date, pts, opponent);
    pushStat(output, 'NBA', player, 'player_rebounds', date, reb, opponent);
    pushStat(output, 'NBA', player, 'player_assists', date, ast, opponent);
    pushStat(output, 'NBA', player, 'player_threes', date, numeric(row.fg3m), opponent);
    pushStat(output, 'NBA', player, 'player_blocks', date, numeric(row.blk), opponent);
    pushStat(output, 'NBA', player, 'player_steals', date, numeric(row.stl), opponent);
    pushStat(output, 'NBA', player, 'player_points_rebounds_assists', date,
      pts !== null && reb !== null && ast !== null ? pts + reb + ast : null, opponent);
  }
  return output;
}

function nflRows(input: CsvRow[]): LogRow[] {
  const output: LogRow[] = [];
  for (const row of input) {
    const player = row.player_display_name || row.player_name || '';
    const season = numeric(row.season);
    const week = numeric(row.week);
    if (season === null || week === null || week < 1 || week > 22) continue;
    // Weekly data does not supply a calendar date. An explicitly labelled
    // YYYY-Www key retains correct chronological sorting without inventing one.
    const date = `${season}-W${String(week).padStart(2, '0')}`;
    const opponent = row.opponent_team || '';
    pushStat(output, 'NFL', player, 'player_pass_yds', date, numeric(row.passing_yards), opponent);
    pushStat(output, 'NFL', player, 'player_rush_yds', date, numeric(row.rushing_yards), opponent);
    pushStat(output, 'NFL', player, 'player_reception_yds', date, numeric(row.receiving_yards), opponent);
    pushStat(output, 'NFL', player, 'player_receptions', date, numeric(row.receptions), opponent);
    pushStat(output, 'NFL', player, 'player_pass_tds', date, numeric(row.passing_tds), opponent);
    pushStat(output, 'NFL', player, 'player_rush_attempts', date, numeric(row.carries ?? row.rushing_attempts), opponent);
    pushStat(output, 'NFL', player, 'player_pass_completions', date, numeric(row.completions), opponent);
  }
  return output;
}

async function loadHistory(sport: Sport): Promise<HistoryResult> {
  const year = new Date().getUTCFullYear();
  const sources = sport === 'NFL'
    ? [year, year - 1].map(season => ({
        season,
        url: `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${season}.csv`
      }))
    : [year + 1, year, year - 1].map(season => ({
        season,
        url: `https://github.com/sportsdataverse/sportsdataverse-data/releases/download/nba_stats_player_game_logs/player_game_logs_${season}.csv`
      }));

  const output: LogRow[] = [];
  const availableSeasons: number[] = [];
  const diagnostics: string[] = [];

  for (const source of sources) {
    const result = await download(source.url);
    if (!result.rows?.length) {
      diagnostics.push(`${source.season}: ${result.status}`);
      continue;
    }
    const converted = sport === 'NFL' ? nflRows(result.rows) : nbaRows(result.rows);
    diagnostics.push(`${source.season}: ${result.status}; ${converted.length} mapped statistics`);
    if (!converted.length) continue;
    for (const row of converted) output.push(row);
    availableSeasons.push(source.season);
  }

  const unique = new Map<string, LogRow>();
  for (const row of output) {
    unique.set(`${row.sport}|${row.player.toLowerCase()}|${row.marketKey}|${row.date}`, row);
  }
  const latest = new Map<string, LogRow[]>();
  for (const row of [...unique.values()].sort((a, b) => b.date.localeCompare(a.date))) {
    const key = `${row.sport}|${row.player.toLowerCase()}|${row.marketKey}`;
    const arr = latest.get(key) || [];
    if (arr.length < 20) {
      arr.push(row);
      latest.set(key, arr);
    }
  }
  const rows = [...latest.values()].flat();
  return {
    rows,
    source: sport === 'NFL' ? 'nflverse weekly player stats' : 'SportsDataverse NBA player game logs',
    season: availableSeasons.length ? Math.max(...availableSeasons) : null,
    updatedAt: new Date().toISOString(),
    message: rows.length
      ? `Loaded ${rows.length} ${sport} player-stat observations from seasons ${availableSeasons.join(', ')}.`
      : `Could not load compatible ${sport} CSV data from published release assets. See diagnostics; manual CSV import is still available.`,
    diagnostics
  };
}

// The dataset is cached in the Node process, but only requested players are sent
// to clients. This avoids 100K+ row JSON responses and browser lockups.
const inflight: Partial<Record<Sport, Promise<HistoryResult>>> = {};

async function getHistory(sport: Sport): Promise<HistoryResult> {
  const existing = cache[sport];
  if (existing && existing.until > Date.now()) return existing.payload;
  if (inflight[sport]) return inflight[sport]!;
  const task = loadHistory(sport).then(payload => {
    cache[sport] = {
      payload,
      until: Date.now() + (payload.rows.length ? TTL : 10 * 60 * 1000)
    };
    return payload;
  });
  inflight[sport] = task;
  try { return await task; }
  finally { delete inflight[sport]; }
}

function filterHistory(payload: HistoryResult, players: string[]): HistoryResult {
  const names = new Set(players.map(p => p.trim().toLowerCase()).filter(Boolean));
  const rows = payload.rows.filter(row => names.has(row.player.trim().toLowerCase()));
  return {
    ...payload,
    rows,
    message: rows.length
      ? `Loaded ${rows.length} player-stat observations for ${names.size} requested players. ${payload.source}.`
      : `No matching published history for ${names.size} requested players. ${payload.message}`,
    diagnostics: payload.diagnostics.slice(0, 6)
  };
}

// A browser GET never dumps the entire dataset.
export async function GET(request: NextRequest) {
  const sport: Sport = request.nextUrl.searchParams.get('sport') === 'NFL' ? 'NFL' : 'NBA';
  return NextResponse.json({ rows: [], source: sport, message: 'Use POST with {sport, players:[...]}; full history is never sent to the browser.' });
}

export async function POST(request: NextRequest) {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object') return NextResponse.json({ message: 'Invalid JSON' }, { status: 400 });
    const input = body as { sport?: string; players?: unknown };
    const sport: Sport = input.sport === 'NFL' ? 'NFL' : 'NBA';
    if (!Array.isArray(input.players) || input.players.length > 120 ||
        input.players.some(p => typeof p !== 'string' || p.length > 100)) {
      return NextResponse.json({ message: 'Provide 1-120 valid player names' }, { status: 400 });
    }
    const players = [...new Set(input.players as string[])];
    if (!players.length) return NextResponse.json({ rows: [], message: 'No players requested' });
    const history = await getHistory(sport);
    return NextResponse.json(filterHistory(history, players), {
      headers: { 'Cache-Control': 'private, no-store' }
    });
  } catch (error) {
    return NextResponse.json({ rows: [], message: error instanceof Error ? error.message : 'History error' }, { status: 502 });
  }
}
