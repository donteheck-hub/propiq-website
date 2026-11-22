import { NextRequest, NextResponse } from 'next/server';
import { verifiedMembership } from '../../../../lib/server-entitlements';
import { GET as getCachedOdds } from '../route';
import type { Prop, Sport } from '../../../../lib/props';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function groupKey(prop: Prop): string {
  const norm = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');
  return [prop.sport, norm(prop.player), norm(prop.event), prop.commence,
    prop.marketKey, prop.side, prop.line].join('|');
}
function bookKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, '');
}
function profitOn100(odds: number): number {
  return odds > 0 ? odds : 10000 / Math.abs(odds);
}
const noStore = { 'Cache-Control': 'private, no-store' };

export async function GET(request: NextRequest) {
  const auth = await verifiedMembership(request);
  if (auth.tier !== 'pro' && auth.tier !== 'elite') {
    return NextResponse.json({ error: 'An active Pro or Elite subscription is required.' },
      { status: auth.available ? 403 : 503, headers: noStore });
  }
  const sportParam = request.nextUrl.searchParams.get('sport');
  if (sportParam !== 'NBA' && sportParam !== 'NFL') {
    return NextResponse.json({ error: 'Choose NBA or NFL.' }, { status: 400, headers: noStore });
  }
  const sport: Sport = sportParam;

  // Use the existing persistent/cache-aware handler rather than starting another
  // upstream request path. Its once-per-Central-day budget remains authoritative.
  const upstream = await getCachedOdds(request);
  const payload: unknown = await upstream.json();
  if (!upstream.ok) {
    return NextResponse.json({ error: 'Cached sportsbook prices are unavailable.' },
      { status: 503, headers: noStore });
  }
  const source = payload as { props?: unknown; updatedAt?: unknown; stale?: unknown };
  if (!Array.isArray(source.props)) {
    return NextResponse.json({ error: 'No verified sportsbook prices available.' },
      { status: 503, headers: noStore });
  }
  const groups = new Map<string, Map<string, Prop>>();
  for (const item of source.props) {
    if (!item || typeof item !== 'object') continue;
    const prop = item as Partial<Prop>;
    const book = typeof prop.bookmaker === 'string' ? bookKey(prop.bookmaker) : '';
    if (prop.source !== 'live' || prop.sport !== sport ||
        !['draftkings', 'fanduel'].includes(book) ||
        typeof prop.player !== 'string' || typeof prop.event !== 'string' ||
        typeof prop.commence !== 'string' || typeof prop.marketKey !== 'string' ||
        (prop.side !== 'Over' && prop.side !== 'Under') ||
        typeof prop.line !== 'number' || !Number.isFinite(prop.line) ||
        typeof prop.odds !== 'number' || !Number.isFinite(prop.odds) ||
        (prop.odds > -100 && prop.odds < 100)) continue;
    const key = groupKey(prop as Prop);
    if (!groups.has(key)) groups.set(key, new Map());
    const books = groups.get(key)!;
    const old = books.get(book);
    if (!old || prop.odds > old.odds) books.set(book, prop as Prop);
  }
  const comparisons = [...groups.values()].filter(group => group.size === 2)
    .map(group => {
      const [best, other] = [...group.values()].sort((a, b) => b.odds - a.odds);
      return { best, other, gain: profitOn100(best.odds) - profitOn100(other.odds) };
    })
    .sort((a, b) => b.gain - a.gain || a.best.player.localeCompare(b.best.player));
  return NextResponse.json({ comparisons, updatedAt: source.updatedAt ?? null,
    stale: source.stale === true, sport }, { headers: noStore });
}
