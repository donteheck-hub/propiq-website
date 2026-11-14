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
  return Number.isInteger(value) ? Math.max(1, Math.min(12, value)) : 4;
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
  const upcoming = events.filter(e => e && typeof e.id === 'string' && typeof e.commence_time === 'string' && typeof e.home_team === 'string' && typeof e.away_team === 'string' && Number.isFinite(Date.parse(e.commence_time)) && Date.parse(e.commence_time) > Date.now()).sort((a, b) => a.commence_time.localeCompare(b.commence_time));
  // NBA usually has multiple props per game; NFL props are often posted closer to kickoff.
  // Scan more NFL fixtures (bounded) so one early event without props cannot hide the next slate.
  const selected = upcoming.slice(0, sport === 'NFL' ? Math.max(8, eventLimit()) : eventLimit());
  const markets = Object.keys(MARKETS[sport]);
  const props: Prop[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  let checked = 0;
  let empty = 0;
  for (const event of selected) {
    try {
      const eventBase = `${base}/events/${encodeURIComponent(event.id)}`;
      // Market discovery prevents a single unavailable NFL market from causing
      // the whole event's odds request to fail with INVALID_MARKET.
      let supported = markets;
      if (sport === 'NFL') {
        try {
          const marketData = await fetchJSON(`${eventBase}/markets?apiKey=${encodeURIComponent(key)}&bookmakers=draftkings,fanduel`) as { bookmakers?: { markets?: { key: string }[] }[] };
          const available = new Set((marketData.bookmakers ?? []).flatMap(book =>
            Array.isArray(book.markets) ? book.markets.map(market => market.key) : []));
          if (available.size > 0) supported = markets.filter(market => available.has(market));
        } catch { /* Market discovery is optional; try configured markets. */ }
      }
      if (supported.length === 0) { checked++; empty++; continue; }
      const makeUrl = (keys: string[]) => `${eventBase}/odds?apiKey=${encodeURIComponent(key)}&bookmakers=draftkings,fanduel&markets=${keys.join(',')}&oddsFormat=american`;
      let data: { bookmakers?: { key: string; title: string; markets?: { key: string; outcomes?: { name: string; description?: string; point?: number; price: number }[] }[] }[] };
      try {
        data = await fetchJSON(makeUrl(supported));
      } catch (error) {
        // Providers may temporarily return 422 when some prop markets are unavailable.
        // Retry only a smaller core group, not guessed or unsupported market keys.
        if (sport !== 'NFL' || !String(error).includes('422')) throw error;
        const core = ['player_pass_yds', 'player_rush_yds', 'player_reception_yds', 'player_receptions'];
        const retry = core.filter(k => supported.includes(k));
        if (!retry.length || retry.length === supported.length) throw error;
        data = await fetchJSON(makeUrl(retry));
        warnings.push(`${event.away_team} @ ${event.home_team}: some markets unavailable; core markets checked.`);
      }
      if (data.bookmakers !== undefined && !Array.isArray(data.bookmakers)) throw Error('Provider returned malformed bookmaker data');
      const priorCount = props.length;
      for (const book of data.bookmakers ?? []) {
        if (!book || !['draftkings', 'fanduel'].includes(book.key) || !Array.isArray(book.markets)) continue;
        for (const m of book.markets) {
        if (!MARKETS[sport][m.key]) continue;
        for (const outcome of Array.isArray(m.outcomes) ? m.outcomes : []) {
          if ((outcome.name !== 'Over' && outcome.name !== 'Under') || !outcome.description || !Number.isFinite(outcome.point) || !Number.isFinite(outcome.price) || outcome.price === 0 || outcome.point! < 0) continue;
          const id = [sport, event.id, book.key, m.key, outcome.description, outcome.name, outcome.point].join(':');
          if (seen.has(id)) continue;
          seen.add(id);
          props.push({ id, sport, player: outcome.description, market: MARKETS[sport][m.key], marketKey: m.key, line: outcome.point!, side: outcome.name, odds: outcome.price, bookmaker: book.title, event: `${event.away_team} @ ${event.home_team}`, commence: event.commence_time, source: 'live' });
        }
        }
      }
      checked++;
      if (props.length === priorCount) empty++;
    } catch (error) {
      // One unsupported event should not hide successful lines from other games.
      warnings.push(`${event.away_team} @ ${event.home_team}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  // If everything failed, don't falsely present a successful live data refresh.
  if (selected.length && !checked && warnings.length) throw Error(`No event props fetched. ${warnings[0]}`);
  const detail = props.length === 0 ? `No DraftKings/FanDuel player props returned. ${empty} checked game(s) had no supported posted markets; check again closer to kickoff.` : `${props.length} sportsbook props found.`;
  return { props, configured: true, updatedAt: new Date().toISOString(), eventsChecked: checked, availableEvents: upcoming.length, warnings, notice: `Checked ${checked} of ${upcoming.length} upcoming games (${selected.length} attempted). ${detail} ${warnings.length ? `${warnings.length} provider warning(s): ${warnings.slice(0, 2).join('; ')}` : ''}` }; 
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
