import { NextRequest, NextResponse } from 'next/server';
import { MARKETS, type Prop, type Sport } from '../../../lib/props';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sportKeys: Record<Sport, string> = { NBA: 'basketball_nba', NFL: 'americanfootball_nfl' };
type Payload = { props: Prop[]; configured: boolean; updatedAt: string; eventsChecked: number; availableEvents: number; warnings: string[]; notice: string };
const CACHE_MS = 5 * 60 * 1000;
const cache: Partial<Record<Sport, { until: number; payload: Payload }>> = {};
const inflight: Partial<Record<Sport, Promise<Payload>>> = {};

function eventLimit(): number {
  const value = Number(process.env.ODDS_EVENTS_PER_SPORT ?? '4');
  return Number.isInteger(value) ? Math.max(1, Math.min(8, value)) : 4;
}

async function fetchJSON(url: string) {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw Error(`Provider HTTP ${response.status}`);
  return response.json();
}

async function load(sport: Sport, key: string): Promise<Payload> {
  const base = `https://api.the-odds-api.com/v4/sports/${sportKeys[sport]}`;
  const events = await fetchJSON(`${base}/events?apiKey=${encodeURIComponent(key)}&dateFormat=iso`) as { id: string; home_team: string; away_team: string; commence_time: string }[];
  if (!Array.isArray(events)) throw Error('Provider returned invalid event data');
  const upcoming = events.filter(e => Number.isFinite(Date.parse(e.commence_time)) && Date.parse(e.commence_time) > Date.now()).sort((a, b) => a.commence_time.localeCompare(b.commence_time));
  const selected = upcoming.slice(0, eventLimit());
  const markets = Object.keys(MARKETS[sport]).join(',');
  const props: Prop[] = [];
  const warnings: string[] = [];
  let checked = 0;
  for (const event of selected) {
    try {
      const url = `${base}/events/${encodeURIComponent(event.id)}/odds?apiKey=${encodeURIComponent(key)}&bookmakers=draftkings,fanduel&markets=${markets}&oddsFormat=american`;
      const data = await fetchJSON(url) as { bookmakers?: { key: string; title: string; markets?: { key: string; outcomes?: { name: string; description?: string; point?: number; price: number }[] }[] }[] };
      checked++;
      for (const book of data.bookmakers ?? []) for (const m of book.markets ?? []) {
        if (!MARKETS[sport][m.key]) continue;
        for (const outcome of m.outcomes ?? []) {
          if ((outcome.name !== 'Over' && outcome.name !== 'Under') || !outcome.description || !Number.isFinite(outcome.point) || !Number.isFinite(outcome.price)) continue;
          props.push({ id: [sport, event.id, book.key, m.key, outcome.description, outcome.name, outcome.point].join(':'), sport, player: outcome.description, market: MARKETS[sport][m.key], marketKey: m.key, line: outcome.point!, side: outcome.name, odds: outcome.price, bookmaker: book.title, event: `${event.away_team} @ ${event.home_team}`, commence: event.commence_time, source: 'live' });
        }
      }
    } catch (error) {
      // One unsupported event should not hide successful lines from other games.
      warnings.push(`${event.away_team} @ ${event.home_team}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  // If everything failed, don't falsely present a successful live data refresh.
  if (selected.length && !checked && warnings.length) throw Error(`No event props fetched. ${warnings[0]}`);
  return { props, configured: true, updatedAt: new Date().toISOString(), eventsChecked: checked, availableEvents: upcoming.length, warnings, notice: `Checked ${checked} of ${upcoming.length} upcoming games (maximum ${eventLimit()} per refresh). ${warnings.length ? `${warnings.length} game(s) had provider errors.` : 'Data availability depends on posted sportsbook markets.'}` };
}

export async function GET(req: NextRequest) {
  const sport: Sport = req.nextUrl.searchParams.get('sport') === 'NFL' ? 'NFL' : 'NBA';
  const key = process.env.ODDS_API_KEY;
  if (!key) return NextResponse.json({ props: [], configured: false, message: 'Set ODDS_API_KEY in your local or Railway server environment.' });
  const cached = cache[sport];
  if (cached && cached.until > Date.now()) return NextResponse.json(cached.payload, { headers: { 'Cache-Control': 'private, no-store' } });
  try {
    if (!inflight[sport]) inflight[sport] = load(sport, key);
    const payload = await inflight[sport]!;
    cache[sport] = { payload, until: Date.now() + CACHE_MS };
    return NextResponse.json(payload, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return NextResponse.json({ props: [], configured: true, message: error instanceof Error ? error.message : 'Unknown provider error' }, { status: 502 });
  } finally {
    delete inflight[sport];
  }
}
