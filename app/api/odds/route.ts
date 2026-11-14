import { NextRequest, NextResponse } from 'next/server';
import { MARKETS, type Prop, type Sport } from '../../../lib/props';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sportKeys: Record<Sport, string> = { NBA: 'basketball_nba', NFL: 'americanfootball_nfl' };
const DEFAULT_MARKETS: Record<Sport, string[]> = {
  NBA: ['player_points', 'player_rebounds'],
  NFL: ['player_pass_yds', 'player_reception_yds'],
};

type Payload = {
  props: Prop[]; configured: boolean; updatedAt: string;
  eventsChecked: number; availableEvents: number; warnings: string[]; notice: string;
};
type CacheEntry = { payload: Payload; expiresAt: number };
const cached: Partial<Record<Sport, CacheEntry>> = {};
const inflight: Partial<Record<Sport, Promise<Payload>>> = {};
let budgetDate = '';
let spentToday = 0;
let pausedUntil = 0;
let providerRemaining: number | null = null;
let providerUsed: number | null = null;

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}
function config() {
  return {
    cacheMs: boundedInteger(process.env.ODDS_CACHE_HOURS, 12, 1, 48) * 3600000,
    staleMs: 48 * 3600000,
    maxEvents: boundedInteger(process.env.ODDS_MAX_EVENTS, 1, 1, 4),
    dailyBudget: boundedInteger(process.env.ODDS_DAILY_CREDIT_BUDGET, 8, 1, 100),
  };
}
function marketsFor(sport: Sport) {
  const key = sport === 'NBA' ? 'ODDS_NBA_MARKETS' : 'ODDS_NFL_MARKETS';
  const requested = process.env[key]?.split(',').map(s => s.trim()).filter(Boolean);
  const allowed = new Set(Object.keys(MARKETS[sport]));
  const valid = [...new Set((requested?.length ? requested : DEFAULT_MARKETS[sport]).filter(m => allowed.has(m)))];
  return valid.slice(0, 4);
}
function resetDailyBudget() {
  const today = new Date().toISOString().slice(0, 10);
  if (budgetDate !== today) { budgetDate = today; spentToday = 0; }
}
function meta() {
  resetDailyBudget();
  const settings = config();
  return {
    creditSaving: true,
    cacheHours: settings.cacheMs / 3600000,
    usedToday: spentToday,
    dailyBudget: settings.dailyBudget,
    providerRemaining,
    providerUsed,
    pausedUntil: pausedUntil > Date.now() ? new Date(pausedUntil).toISOString() : null,
    note: 'Credit budget and cache are per running server instance, not shared across Railway replicas or restarts.',
  };
}
class ProviderError extends Error {
  constructor(readonly httpStatus: number, message: string) { super(message); this.name = 'ProviderError'; }
}
async function readProvider(url: string, reservedCredits = 0): Promise<unknown> {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
  const last = Number(response.headers.get('x-requests-last'));
  const remaining = Number(response.headers.get('x-requests-remaining'));
  const used = Number(response.headers.get('x-requests-used'));
  if (response.headers.has('x-requests-remaining') && Number.isFinite(remaining)) providerRemaining = remaining;
  if (response.headers.has('x-requests-used') && Number.isFinite(used)) providerUsed = used;
  // We reserve an estimated cost before a provider request. When the provider
  // supplies its authoritative cost, reconcile the estimate, even on failures.
  if (reservedCredits > 0 && response.headers.has('x-requests-last') && Number.isFinite(last) && last >= 0) {
    spentToday = Math.max(0, spentToday + last - reservedCredits);
  }
  if (!response.ok) {
    const messages: Record<number, string> = {
      401: 'The Odds API rejected the key (HTTP 401). This can mean an invalid key or exhausted credits. Verify your account quota and Railway ODDS_API_KEY.',
      403: 'The Odds API denied access to this market (HTTP 403). Check your plan and market coverage.',
      429: 'The Odds API rate limit or credit quota has been reached (HTTP 429).',
    };
    throw new ProviderError(response.status, messages[response.status] ?? `Odds provider HTTP ${response.status}`);
  }
  return response.json();
}
async function load(sport: Sport, key: string): Promise<Payload> {
  const settings = config();
  const mk = marketsFor(sport);
  const base = `https://api.the-odds-api.com/v4/sports/${sportKeys[sport]}`;
  const events = await readProvider(`${base}/events?apiKey=${encodeURIComponent(key)}&dateFormat=iso`) as
    { id: string; home_team: string; away_team: string; commence_time: string }[];
  if (!Array.isArray(events)) throw new Error('Provider returned malformed events.');
  const upcoming = events.filter(e => e && typeof e.id === 'string' && typeof e.home_team === 'string' && typeof e.away_team === 'string' && typeof e.commence_time === 'string' && Date.parse(e.commence_time) > Date.now())
    .sort((a, b) => a.commence_time.localeCompare(b.commence_time));
  const selected = upcoming.slice(0, settings.maxEvents);
  const props: Prop[] = [];
  const warnings: string[] = [];
  let checked = 0;
  const seen = new Set<string>();
  for (const event of selected) {
    resetDailyBudget();
    // Cost can be up to one credit per market with the selected books/region.
    // Reserve conservatively before calling, and reject if the local cap is reached.
    if (providerRemaining !== null && providerRemaining < mk.length) {
      warnings.push('Provider reports insufficient remaining credits for the selected markets.');
      break;
    }
    if (spentToday + mk.length > settings.dailyBudget) {
      warnings.push('Daily credit-saving budget reached; remaining games were not requested.');
      break;
    }
    spentToday += mk.length;
    try {
      const url = `${base}/events/${encodeURIComponent(event.id)}/odds?apiKey=${encodeURIComponent(key)}&bookmakers=draftkings,fanduel&markets=${mk.join(',')}&oddsFormat=american`;
      const data = await readProvider(url, mk.length) as { bookmakers?: { key: string; title: string; markets?: { key: string; outcomes?: { name: string; description?: string; point?: number; price: number }[] }[] }[] };
      if (data.bookmakers !== undefined && !Array.isArray(data.bookmakers)) throw new Error('Malformed bookmaker data');
      for (const book of data.bookmakers ?? []) {
        if (!book || !['draftkings', 'fanduel'].includes(book.key)) continue;
        for (const market of book.markets ?? []) {
          if (!MARKETS[sport][market.key]) continue;
          for (const o of market.outcomes ?? []) {
            if ((o.name !== 'Over' && o.name !== 'Under') || !o.description || !Number.isFinite(o.point) || o.point! < 0 || !Number.isFinite(o.price) || !o.price) continue;
            const id = [sport, event.id, book.key, market.key, o.description, o.name, o.point].join(':');
            if (seen.has(id)) continue;
            seen.add(id);
            props.push({ id, sport, player: o.description, market: MARKETS[sport][market.key], marketKey: market.key,
              line: o.point!, side: o.name, odds: o.price, bookmaker: book.title,
              event: `${event.away_team} @ ${event.home_team}`, commence: event.commence_time, source: 'live' });
          }
        }
      }
      checked++;
    } catch (error) {
      if (error instanceof ProviderError && [401, 403, 429].includes(error.httpStatus)) {
        pausedUntil = Date.now() + 24 * 3600000; // Avoid repeated rejected requests from visitors.
        throw error;
      }
      warnings.push(`${event.away_team} @ ${event.home_team}: ${error instanceof Error ? error.message : 'Provider error'}`);
    }
  }
  return { props, configured: true, updatedAt: new Date().toISOString(), eventsChecked: checked,
    availableEvents: upcoming.length, warnings,
    notice: `Credit-saving mode: ${checked} of ${upcoming.length} upcoming games checked; ${mk.join(', ')} markets requested. ${warnings.join(' ')} ${props.length ? `${props.length} props returned.` : 'No player props returned.'}` };
}

export async function GET(req: NextRequest) {
  const sport: Sport = req.nextUrl.searchParams.get('sport') === 'NFL' ? 'NFL' : 'NBA';
  const key = process.env.ODDS_API_KEY?.trim();
  const now = Date.now();
  const entry = cached[sport];
  const send = (payload: Payload, stale: boolean, extra = '') => NextResponse.json({
    ...payload, stale, cached: true,
    notice: `${stale ? 'STALE ODDS — for reference only, not current prices. ' : 'Cached odds — no new API credits spent. '}${extra}${payload.notice}`,
    creditStatus: meta(),
  }, { headers: { 'Cache-Control': 'private, no-store' } });
  if (entry && now < entry.expiresAt) return send(entry.payload, false);
  if (!key) {
    if (entry && now - Date.parse(entry.payload.updatedAt) < 48 * 3600000) return send(entry.payload, true, 'API key unavailable. ');
    return NextResponse.json({ props: [], configured: false, message: 'Set ODDS_API_KEY in Railway. Historical research can continue without live odds.', creditStatus: meta() }, { status: 503 });
  }
  resetDailyBudget();
  const settings = config();
  const blocked = now < pausedUntil || spentToday >= settings.dailyBudget || providerRemaining === 0;
  if (blocked) {
    if (entry && now - Date.parse(entry.payload.updatedAt) < settings.staleMs) return send(entry.payload, true, 'Requests paused to protect credits. ');
    return NextResponse.json({ props: [], configured: true, message: 'Credit-saving mode paused new odds requests: daily budget, provider quota, or temporary authentication cooldown. Historical data remains separate.', creditStatus: meta() }, { status: 503 });
  }
  try {
    if (!inflight[sport]) inflight[sport] = load(sport, key);
    const payload = await inflight[sport]!;
    cached[sport] = { payload, expiresAt: Date.now() + settings.cacheMs };
    return NextResponse.json({ ...payload, stale: false, cached: false, creditStatus: meta() }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (entry && now - Date.parse(entry.payload.updatedAt) < settings.staleMs) return send(entry.payload, true, 'Provider request failed. ');
    const status = error instanceof ProviderError ? error.httpStatus : 502;
    return NextResponse.json({ props: [], configured: true, message: error instanceof Error ? error.message : 'Unable to load odds.', creditStatus: meta() }, { status });
  } finally {
    delete inflight[sport];
  }
}
