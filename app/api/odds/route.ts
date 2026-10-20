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
};

const TTL = 6 * 60 * 60 * 1000;
const cache: Partial<Record<Sport, { until: number; payload: HistoryResult }>> = {};

function parseCSV(content: string): CsvRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (char === '"') {
      if (quoted && content[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(cell); cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && content[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(x => x.trim())) rows.push(row);
      row = [];
    } else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0].map(v => v.trim().toLowerCase().replace(/^\ufeff/, ''));
  return rows.slice(1).map(fields => Object.fromEntries(headers.map((h, i) => [h, (fields[i] || '').trim()])));
}

async function download(url: string): Promise<CsvRow[] | null> {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(16000),
      next: { revalidate: 21600 }
    });
    if (!response.ok) return null;
    const length = Number(response.headers.get('content-length') || 0);
    if (length > 20 * 1024 * 1024) return null;
    const text = await response.text();
    if (text.length > 20 * 1024 * 1024 || !text.includes(',')) return null;
    return parseCSV(text);
  } catch { return null; }
}

function numeric(value: string | undefined): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pushStat(out: LogRow[], sport: Sport, player: string, marketKey: string, date: string, value: number | null, opponent: string) {
  if (value === null || !player || !date) return;
  out.push({ sport, player, marketKey, date, value, opponent });
}

function nbaRows(input: CsvRow[]): LogRow[] {
  const output: LogRow[] = [];
  for (const r of input) {
    const player = r.player_name || r.player || [r.first_name, r.family_name].filter(Boolean).join(' ');
    const date = (r.game_date || r.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const game = r.matchup || '';
    const opponent = game.split(/@|vs\.?/i).pop()?.trim() || '';
    const pts = numeric(r.pts), reb = numeric(r.reb), ast = numeric(r.ast);
    pushStat(output, 'NBA', player, 'player_points', date, pts, opponent);
    pushStat(output, 'NBA', player, 'player_rebounds', date, reb, opponent);
    pushStat(output, 'NBA', player, 'player_assists', date, ast, opponent);
    pushStat(output, 'NBA', player, 'player_threes', date, numeric(r.fg3m), opponent);
    pushStat(output, 'NBA', player, 'player_blocks', date, numeric(r.blk), opponent);
    pushStat(output, 'NBA', player, 'player_steals', date, numeric(r.stl), opponent);
    pushStat(output, 'NBA', player, 'player_points_rebounds_assists', date,
      pts !== null && reb !== null && ast !== null ? pts + reb + ast : null, opponent);
  }
  return output;
}

function nflRows(input: CsvRow[]): LogRow[] {
  const output: LogRow[] = [];
  for (const r of input) {
    const player = r.player_display_name || r.player_name || '';
    const year = numeric(r.season), week = numeric(r.week);
    if (year === null || week === null || week < 1 || week > 22) continue;
    // Weekly dataset has a week number rather than a verified game date.
    // Keep week-keys explicitly labeled, never invent a calendar kickoff date.
    const date = `${year}-W${String(week).padStart(2, '0')}`;
    const opponent = r.opponent_team || '';
    pushStat(output, 'NFL', player, 'player_pass_yds', date, numeric(r.passing_yards), opponent);
    pushStat(output, 'NFL', player, 'player_rush_yds', date, numeric(r.rushing_yards), opponent);
    pushStat(output, 'NFL', player, 'player_reception_yds', date, numeric(r.receiving_yards), opponent);
    pushStat(output, 'NFL', player, 'player_receptions', date, numeric(r.receptions), opponent);
    pushStat(output, 'NFL', player, 'player_pass_tds', date, numeric(r.passing_tds), opponent);
    pushStat(output, 'NFL', player, 'player_rush_attempts', date, numeric(r.carries || r.rushing_attempts), opponent);
    pushStat(output, 'NFL', player, 'player_pass_completions', date, numeric(r.completions), opponent);
  }
  return output;
}

async function loadHistory(sport: Sport): Promise<HistoryResult> {
  const currentYear = new Date().getUTCFullYear();
  const candidates = sport === 'NFL'
    ? [currentYear, currentYear - 1].map(year => ({ year,
        url: `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${year}.csv` }))
    : [currentYear + 1, currentYear].map(year => ({ year,
        url: `https://github.com/sportsdataverse/sportsdataverse-data/releases/download/nba_stats_player_game_logs/player_game_logs_${year}.csv` }));

  const output: LogRow[] = [];
  const successful: number[] = [];
  for (const item of candidates) {
    const csv = await download(item.url);
    if (!csv?.length) continue;
    const converted = sport === 'NFL' ? nflRows(csv) : nbaRows(csv);
    if (!converted.length) continue;
    output.push(...converted);
    successful.push(item.year);
  }

  const deduped = Array.from(new Map(output.map(r => [
    `${r.sport}:${r.player.toLowerCase()}:${r.marketKey}:${r.date}`, r
  ])).values());
  // Keep the newest 20 observations per player and stat to control payload size.
  const latest = new Map<string, LogRow[]>();
  for (const row of deduped.sort((a, b) => b.date.localeCompare(a.date))) {
    const key = `${row.sport}|${row.player.toLowerCase()}|${row.marketKey}`;
    const arr = latest.get(key) || [];
    if (arr.length < 20) { arr.push(row); latest.set(key, arr); }
  }
  const recentRows = [...latest.values()].flat();
  return {
    rows: recentRows,
    source: sport === 'NFL' ? 'nflverse (weekly stats)' : 'SportsDataverse / hoopR (NBA game logs)',
    season: successful.length ? Math.max(...successful) : null,
    updatedAt: new Date().toISOString(),
    message: recentRows.length
      ? `Imported published ${sport} historical stats for ${successful.join(', ')}. Coverage may lag current games.`
      : `Published ${sport} history couldn't be loaded. CSV import remains available. Check the provider's release assets.`
  };
}

export async function GET(request: NextRequest) {
  const sport: Sport = request.nextUrl.searchParams.get('sport') === 'NFL' ? 'NFL' : 'NBA';
  const existing = cache[sport];
  if (existing && existing.until > Date.now()) return NextResponse.json(existing.payload);
  const payload = await loadHistory(sport);
  // Retry failures earlier than successful downloads.
  cache[sport] = { payload, until: Date.now() + (payload.rows.length ? TTL : 10 * 60 * 1000) };
  return NextResponse.json(payload);
}
