import { NextRequest, NextResponse } from 'next/server';
import { MARKETS, gameOpponent, logSeason, normalize, validLogDate, type LogRow, type Sport } from '../../../lib/props';
import { verifiedMembership } from '../../../lib/server-entitlements';
import type { MembershipTier } from '../../../lib/entitlements';
import { getHistory, type HistoryResult } from '../../../lib/history-data';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function filterHistory(payload: HistoryResult, players: string[], season: number | 'all', tier: MembershipTier): HistoryResult {
  const names = new Set(players.map(p => normalize(p.trim())).filter(Boolean));
  const matching = payload.rows.filter(row => names.has(normalize(row.player.trim())) && (season === 'all' || logSeason(row) === season));
  // Only the Elite tier may retrieve unrestricted player-stat history.
  // Free keeps Last 5/10; Pro keeps Last 20 for the historical trend finder.
  // Cap independently by player, stat, and season to preserve each stat's timeline.
  const limit = tier === 'elite' ? Number.POSITIVE_INFINITY : tier === 'pro' ? 20 : 10;
  const grouped = new Map<string, LogRow[]>();
  for (const row of matching) {
    const key = `${normalize(row.player)}|${row.marketKey}|${logSeason(row)}`;
    const group = grouped.get(key);
    if (group) group.push(row);
    else grouped.set(key, [row]);
  }
  const rows: LogRow[] = [];
  for (const group of grouped.values()) {
    group.sort((a, b) => b.date.localeCompare(a.date));
    rows.push(...group.slice(0, limit));
  }
  return {
    ...payload,
    rows,
    message: rows.length
      ? `Loaded ${rows.length} player-stat observations for ${names.size} requested players. ${payload.source}.`
      : `No matching game logs for ${names.size} requested players. ${payload.message} ${payload.diagnostics.slice(0, 3).join('; ')}`, 
    diagnostics: payload.diagnostics.slice(0, 6)
  };
}

// A browser GET never dumps the entire dataset.
export async function GET(request: NextRequest) {
  const sport: Sport = request.nextUrl.searchParams.get('sport') === 'NFL' ? 'NFL' : 'NBA';
  return NextResponse.json({ rows: [], source: sport, message: 'Use POST with {sport, players:[...]}; full history is never sent to the browser.' });
}

// Pro/Elite research is calculated on trusted server-side game logs. Browser
// clients may supply a prop line but cannot supply the observed game results.
type TrendRequest = { player: string; marketKey: string; line: number; side: 'Over' | 'Under'; opponent?: string };
function validTrend(value: unknown, sport: Sport): value is TrendRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Partial<TrendRequest>;
  return typeof v.player === 'string' && v.player.trim().length > 0 && v.player.length <= 100 &&
    typeof v.marketKey === 'string' && Object.hasOwn(MARKETS[sport], v.marketKey) &&
    typeof v.line === 'number' && Number.isFinite(v.line) && v.line >= 0 && v.line <= 10000 &&
    (v.side === 'Over' || v.side === 'Under') &&
    (v.opponent === undefined || (typeof v.opponent === 'string' && v.opponent.length <= 100));
}

function summarizeTrend(rows: LogRow[], trend: TrendRequest, season: number | 'all') {
  const player = normalize(trend.player);
  const opponent = trend.opponent ? normalize(trend.opponent) : null;
  const matched = rows.filter(row => row.marketKey === trend.marketKey &&
    normalize(row.player) === player && (season === 'all' || logSeason(row) === season) &&
    (!opponent || normalize(row.opponent || '').includes(opponent)))
    .sort((a,b) => b.date.localeCompare(a.date));
  const sample = (size: number) => {
    const games = matched.slice(0, size);
    const hits = games.filter(g => trend.side === 'Over' ? g.value > trend.line : g.value < trend.line).length;
    const pushes = games.filter(g => g.value === trend.line).length;
    return { games: games.length, hits, pushes, misses: games.length - hits - pushes,
      hitRate: games.length ? Math.round(100 * hits / games.length) : null,
      average: games.length ? Math.round(10 * games.reduce((sum, g) => sum + g.value, 0) / games.length) / 10 : null };
  };
  return { player: trend.player, marketKey: trend.marketKey, line: trend.line,
    side: trend.side, opponent: trend.opponent || null,
    last5: sample(5), last10: sample(10), last20: sample(20) };
}

// Matchup Center consumes only server-derived opponent aggregates, never browser-imported logs.
function summarizeMatchup(rows: LogRow[], trend: TrendRequest, season: number | 'all') {
  const matched = rows.filter(row => row.marketKey === trend.marketKey &&
    normalize(row.player) === normalize(trend.player) &&
    (season === 'all' || logSeason(row) === season));
  const summarize = (games: LogRow[]) => {
    const hits = games.filter(g => trend.side === 'Over' ? g.value > trend.line : g.value < trend.line).length;
    const pushes = games.filter(g => g.value === trend.line).length;
    return { games: games.length, hits, pushes,
      average: games.length ? Math.round(games.reduce((sum, g) => sum + g.value, 0) / games.length * 10) / 10 : null };
  };
  const opponents = new Map<string, LogRow[]>();
  for (const row of matched) {
    const opponent = gameOpponent(row);
    if (!opponent || opponent === 'UNKNOWN') continue;
    const group = opponents.get(opponent) || [];
    group.push(row);
    opponents.set(opponent, group);
  }
  return { player: trend.player, marketKey: trend.marketKey, line: trend.line, side: trend.side,
    all: summarize(matched),
    opponents: [...opponents.entries()].sort(([a], [b]) => a.localeCompare(b))
      .slice(0, 100).map(([opponent, games]) => ({ opponent, ...summarize(games) })) };
}

const PRIVATE_HEADERS = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

export async function POST(request: NextRequest) {
  try {
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > 32_768) return NextResponse.json({ message: 'Request is too large.' }, { status: 413 });
    const text = await request.text();
    if (text.length > 32_768) return NextResponse.json({ message: 'Request is too large.' }, { status: 413 });
    let body: unknown;
    try { body = JSON.parse(text); } catch { return NextResponse.json({ message: 'Malformed JSON' }, { status: 400 }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ message: 'Invalid JSON' }, { status: 400 });
    const input = body as { mode?: unknown; sport?: unknown; players?: unknown; season?: unknown; trends?: unknown };
    if (input.sport !== 'NBA' && input.sport !== 'NFL') return NextResponse.json({ message: 'sport must be NBA or NFL' }, { status: 400 });
    const sport = input.sport;
    const season: number | 'all' = input.season === 'all' ? 'all' :
      typeof input.season === 'number' && Number.isInteger(input.season) && input.season >= 2000 && input.season <= 2100
        ? input.season : 'all';

    // Premium route: zero history or calculated results are returned before
    // entitlement verification. The existing basic history route remains intact.
    if (input.mode === 'trend-summary' || input.mode === 'matchup-summary') {
      if (!Array.isArray(input.trends) || input.trends.length < 1 || input.trends.length > 20 ||
          !input.trends.every(row => validTrend(row, sport))) {
        return NextResponse.json({ message: 'Provide 1-20 valid player trend requests.' }, { status: 400, headers: PRIVATE_HEADERS });
      }
      const membership = await verifiedMembership(request);
      if (membership.tier === 'free' || !membership.authenticated || !membership.available) {
        return NextResponse.json({ message: 'An active Pro or Elite membership is required.' }, { status: 403, headers: PRIVATE_HEADERS });
      }
      const history = await getHistory(sport); // No Odds API call or quota usage.
      if (input.mode === 'matchup-summary') {
        return NextResponse.json({ sport, season, mode: 'matchup-summary', source: history.source,
          updatedAt: history.updatedAt,
          matchups: (input.trends as TrendRequest[]).map(t => summarizeMatchup(history.rows, t, season)),
          disclaimer: 'Past results are not forecasts.' }, { headers: PRIVATE_HEADERS });
      }
      return NextResponse.json({ sport, season, mode: 'trend-summary',
        source: history.source, updatedAt: history.updatedAt,
        // Last 20 and opponent-specific research is computed server-side.
        trends: (input.trends as TrendRequest[]).map(t => summarizeTrend(history.rows, t, season)),
        disclaimer: 'Historical observed hit rates are not future win probabilities.'
      }, { headers: PRIVATE_HEADERS });
    }
    if (input.mode !== undefined) return NextResponse.json({ message: 'Unsupported history mode.' }, { status: 400 });

    if (!Array.isArray(input.players) || input.players.length < 1 || input.players.length > 120 ||
        input.players.some(p => typeof p !== 'string' || p.length > 100 || !p.trim())) {
      return NextResponse.json({ message: 'Provide 1-120 valid player names' }, { status: 400 });
    }
    const players = [...new Set(input.players as string[])];
    const membership = await verifiedMembership(request);
    const history = await getHistory(sport);
    return NextResponse.json(filterHistory(history, players, season, membership.tier), { headers: PRIVATE_HEADERS });
  } catch {
    // Do not send internal network, provider, or database exception details to users.
    return NextResponse.json({ rows: [], message: 'History service temporarily unavailable.' },
      { status: 502, headers: PRIVATE_HEADERS });
  }
}
