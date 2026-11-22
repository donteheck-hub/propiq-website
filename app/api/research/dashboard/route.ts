import { NextRequest, NextResponse } from 'next/server';
import { verifiedMembership } from '../../../../lib/server-entitlements';
import { GET as getCachedOdds } from '../../odds/route';
import { getHistory } from '../../../../lib/history-data';
import { currentSeason, logSeason, normalize, type LogRow, type Prop, type Sport } from '../../../../lib/props';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

type EliteTrend = { prop: Prop; hits: number; games: number; rate: number };
function validOffer(value: unknown, sport: Sport): value is Prop {
  if (!value || typeof value !== 'object') return false;
  const p = value as Partial<Prop>;
  return p.source === 'live' && p.sport === sport &&
    typeof p.id === 'string' && typeof p.player === 'string' && !!p.player.trim() &&
    typeof p.marketKey === 'string' && typeof p.market === 'string' &&
    (p.side === 'Over' || p.side === 'Under') &&
    typeof p.line === 'number' && Number.isFinite(p.line) &&
    typeof p.odds === 'number' && Number.isFinite(p.odds) &&
    typeof p.bookmaker === 'string' && typeof p.event === 'string' && typeof p.commence === 'string';
}

export async function GET(request: NextRequest) {
  const membership = await verifiedMembership(request);
  if (membership.tier !== 'elite' || !membership.authenticated || !membership.available) {
    return NextResponse.json({ error: 'An active Elite subscription is required.' },
      { status: membership.available ? 403 : 503, headers: privateHeaders });
  }
  const sport = request.nextUrl.searchParams.get('sport');
  const view = request.nextUrl.searchParams.get('season');
  if ((sport !== 'NBA' && sport !== 'NFL') || !['current', 'previous', 'all'].includes(view || '')) {
    return NextResponse.json({ error: 'Select a valid sport and season.' }, { status: 400, headers: privateHeaders });
  }
  const selectedSport: Sport = sport;
  const requestedSeason = view === 'all' ? null : currentSeason(selectedSport) - (view === 'previous' ? 1 : 0);
  try {
    // Reuse the authoritative persistent odds cache; never start an independent feed.
    const oddsResponse = await getCachedOdds(request);
    if (!oddsResponse.ok) throw new Error('Cached odds unavailable');
    const oddsPayload = await oddsResponse.json() as { props?: unknown; updatedAt?: string; stale?: boolean };
    if (!Array.isArray(oddsPayload.props)) throw new Error('Invalid cached odds');
    const offers = oddsPayload.props.filter((item): item is Prop => validOffer(item, selectedSport));
    const history = await getHistory(selectedSport);
    const index = new Map<string, LogRow[]>();
    for (const row of history.rows) {
      if (requestedSeason !== null && logSeason(row) !== requestedSeason) continue;
      const key = `${normalize(row.player)}|${row.marketKey}`;
      const list = index.get(key) || [];
      list.push(row);
      index.set(key, list);
    }
    for (const rows of index.values()) rows.sort((a, b) => b.date.localeCompare(a.date));
    let withHistory = 0;
    let fullTen = 0;
    const uniquePlayers = new Set<string>();
    const trends = new Map<string, EliteTrend>();
    for (const prop of offers) {
      uniquePlayers.add(normalize(prop.player));
      const games = index.get(`${normalize(prop.player)}|${prop.marketKey}`) || [];
      if (games.length) withHistory++;
      if (games.length < 10) continue;
      fullTen++;
      const sample = games.slice(0, 10);
      const hits = sample.filter(g => prop.side === 'Over' ? g.value > prop.line : g.value < prop.line).length;
      const key = [normalize(prop.player), prop.marketKey, prop.side, prop.line, normalize(prop.event), prop.commence].join('|');
      const previous = trends.get(key);
      if (!previous || prop.odds > previous.prop.odds) trends.set(key, { prop, hits, games: 10, rate: Math.round(hits * 10) });
    }
    return NextResponse.json({
      sport, season: view, updatedAt: oddsPayload.updatedAt || null, stale: oddsPayload.stale === true,
      coverage: { live: offers.length, uniquePlayers: uniquePlayers.size, withHistory, fullTen },
      trends: [...trends.values()].sort((a, b) => b.rate - a.rate || a.prop.player.localeCompare(b.prop.player)).slice(0, 5),
      disclaimer: 'Observed results are not predictions. Incomplete game-log coverage may affect rankings.'
    }, { headers: privateHeaders });
  } catch {
    return NextResponse.json({ error: 'Elite dashboard research is temporarily unavailable.' }, { status: 503, headers: privateHeaders });
  }
}
