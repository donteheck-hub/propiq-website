import { NextRequest, NextResponse } from 'next/server';
import { MARKETS, type Prop, type Sport } from '../../../lib/props';
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sportKeys: Record<Sport, string> = { NBA: 'basketball_nba', NFL: 'americanfootball_nfl' };
const DEFAULT_MARKETS: Record<Sport, string[]> = {
  NBA: ['player_points', 'player_rebounds', 'player_assists', 'player_threes'],
  NFL: ['player_pass_yds', 'player_reception_yds', 'player_rush_yds', 'player_receptions'],
};

type Payload = {
  props: Prop[]; configured: boolean; updatedAt: string;
  eventsChecked: number; availableEvents: number; warnings: string[]; notice: string;
};
type CacheEntry = { payload: Payload; centralDate: string };
const cached: Partial<Record<Sport, CacheEntry>> = {};
const attempted: Partial<Record<Sport, string>> = {};
let storeReady = false;
let storeError = '';
let storeLoaded = false;
let storeLoadTask: Promise<void> | null = null;
let saveTask: Promise<void> = Promise.resolve();
const inflight: Partial<Record<Sport, Promise<Payload>>> = {};
let budgetDate = '';
let spentToday = 0;
let pausedUntil = 0;
let providerRemaining: number | null = null;
let providerUsed: number | null = null;
let providerLast: number | null = null;

// A Railway Volume must be mounted at /data and ODDS_CACHE_DIR=/data/propiq
// to preserve daily refresh decisions across builds, deployments and restarts.
// Fail closed if missing: never silently consume the monthly quota on a restart.
function storeFile(): string | null {
  const directory = process.env.ODDS_CACHE_DIR?.trim();
  return directory ? path.join(directory, 'odds-state.json') : null;
}
function validCacheEntry(value: unknown): value is CacheEntry {
  if (!value || typeof value !== 'object') return false;
  const e = value as Partial<CacheEntry>;
  return typeof e.centralDate === 'string' && !!e.payload &&
    Array.isArray(e.payload.props) && typeof e.payload.updatedAt === 'string';
}
async function initializeStore() {
  if (storeLoaded) return;
  if (storeLoadTask) return storeLoadTask;
  storeLoadTask = (async () => {
    const filename = storeFile();
    if (!filename) { storeError = 'Set ODDS_CACHE_DIR to a persistent Railway volume path, e.g. /data/propiq.'; return; }
    try {
      await mkdir(path.dirname(filename), { recursive: true });
      let loaded: Record<string, unknown> = {};
      try { loaded = JSON.parse(await readFile(filename, 'utf8')) as Record<string, unknown>; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (validCacheEntry(loaded.NBA)) cached.NBA = loaded.NBA;
      if (validCacheEntry(loaded.NFL)) cached.NFL = loaded.NFL;
      if (loaded.attempted && typeof loaded.attempted === 'object') {
        const a = loaded.attempted as Record<string, unknown>;
        for (const sp of ['NBA', 'NFL'] as const) if (typeof a[sp] === 'string') attempted[sp] = a[sp];
      }
      if (typeof loaded.budgetDate === 'string') budgetDate = loaded.budgetDate;
      if (typeof loaded.spentToday === 'number' && Number.isFinite(loaded.spentToday)) spentToday = Math.max(0, loaded.spentToday);
      if (typeof loaded.pausedUntil === 'number' && Number.isFinite(loaded.pausedUntil)) pausedUntil = loaded.pausedUntil;
      for (const [field, set] of [
        ['providerRemaining', (n: number) => { providerRemaining = n; }],
        ['providerUsed', (n: number) => { providerUsed = n; }],
        ['providerLast', (n: number) => { providerLast = n; }],
      ] as const) { const v = loaded[field]; if (typeof v === 'number' && Number.isFinite(v)) set(v); }
      // Verify the volume is writable before ever calling the billed API.
      const probe = path.join(path.dirname(filename), `.odds-write-check-${process.pid}`);
      await writeFile(probe, 'ok');
      await rename(probe, path.join(path.dirname(filename), `.odds-write-check-${process.pid}-ok`));
      await unlink(path.join(path.dirname(filename), `.odds-write-check-${process.pid}-ok`));
      storeReady = true; storeError = '';
    } catch (e) { storeError = e instanceof Error ? e.message : 'Persistent volume unavailable'; }
    finally { storeLoaded = true; }
  })();
  return storeLoadTask;
}
function persistStore(): Promise<void> {
  const file = storeFile();
  if (!storeReady || !file) return Promise.reject(new Error(storeError || 'Persistent odds storage unavailable'));
  const snapshot = JSON.stringify({ NBA: cached.NBA, NFL: cached.NFL, attempted, budgetDate, spentToday, pausedUntil, providerRemaining, providerUsed, providerLast });
  const task = saveTask.catch(() => undefined).then(async () => {
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, snapshot, 'utf8');
    await rename(tmp, file);
  });
  saveTask = task;
  return task.catch((e) => { storeReady = false; storeError = e instanceof Error ? e.message : 'Persistent odds cache write failed'; throw e; });
}


function boundedInteger(value: string | undefined, fallback: number, min: number, max: number) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}
const CENTRAL_TIMEZONE = 'America/Chicago';
const centralDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: CENTRAL_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});
function centralDate(timestamp = Date.now()) {
  const parts = centralDateFormatter.formatToParts(new Date(timestamp));
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function config() {
  return {
    staleMs: 48 * 3600000,
    maxEvents: boundedInteger(process.env.ODDS_MAX_EVENTS, 12, 1, 12),
    dailyBudget: boundedInteger(process.env.ODDS_DAILY_CREDIT_BUDGET, 320, 1, 1200),
    monthlyReserve: boundedInteger(process.env.ODDS_MONTHLY_CREDIT_RESERVE, 2000, 0, 20000),
  };
}
function marketsFor(sport: Sport) {
  const key = sport === 'NBA' ? 'ODDS_NBA_MARKETS' : 'ODDS_NFL_MARKETS';
  const requested = process.env[key]?.split(',').map(s => s.trim()).filter(Boolean);
  const allowed = new Set(Object.keys(MARKETS[sport]));
  const valid = [...new Set((requested?.length ? requested : DEFAULT_MARKETS[sport]).filter(m => allowed.has(m)))];
  return valid.slice(0, 8);
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
    persistentCache: storeReady,
    cacheError: storeReady ? null : (storeError || 'Persistent odds cache unavailable'),
    refreshSchedule: 'Once per Central Time calendar day, on the first request after midnight',
    refreshTimezone: CENTRAL_TIMEZONE,
    centralDate: centralDate(),
    usedToday: spentToday,
    dailyBudget: settings.dailyBudget,
    providerRemaining,
    providerUsed,
    providerLast,
    monthlyReserve: settings.monthlyReserve,
    maxEvents: settings.maxEvents,
    marketsNBA: marketsFor('NBA'),
    marketsNFL: marketsFor('NFL'),
    pausedUntil: pausedUntil > Date.now() ? new Date(pausedUntil).toISOString() : null,
    note: 'Local budget and cache are per Railway process, and reset on restarts. The provider remaining-credit header is the account-wide number when available. These controls are not a guaranteed billing cap.',
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
  if (response.headers.has('x-requests-last') && Number.isFinite(last)) providerLast = last;
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
    if (providerRemaining !== null && providerRemaining - mk.length < settings.monthlyReserve) {
      warnings.push(`Monthly reserve protected: provider reports ${providerRemaining} credits remaining; reserve is ${settings.monthlyReserve}.`);
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
    notice: `Daily midnight Central refresh: ${checked} of ${upcoming.length} upcoming games checked; ${mk.join(', ')} markets requested. ${warnings.join(' ')} ${props.length ? `${props.length} props returned.` : 'No player props returned.'}` };
}

export async function GET(req: NextRequest) {
  const sport: Sport = req.nextUrl.searchParams.get('sport') === 'NFL' ? 'NFL' : 'NBA';
  const key = process.env.ODDS_API_KEY?.trim();
  const now = Date.now();
  await initializeStore();
  const entry = cached[sport];
  const send = (payload: Payload, stale: boolean, extra = '') => NextResponse.json({
    ...payload, stale, cached: true,
    notice: `${stale ? 'STALE ODDS — for reference only, not current prices. ' : 'Cached odds — no new API credits spent. '}${extra}${payload.notice}`,
    creditStatus: meta(),
  }, { headers: { 'Cache-Control': 'private, no-store' } });
  if (!storeReady) return NextResponse.json({ props: entry?.payload.props ?? [], configured: !!key, stale: true, cached: !!entry, message: `Odds refresh paused: ${storeError}. Mount a Railway volume and set ODDS_CACHE_DIR to its path. No provider credits were used.`, creditStatus: meta() }, { status: 200, headers: { 'Cache-Control': 'private, no-store' } });
  if (attempted[sport] === centralDate(now)) {
    if (entry) return send(entry.payload, entry.centralDate !== centralDate(now), 'Daily attempt already recorded; no new API request. ');
    return NextResponse.json({ props: [], configured: !!key, message: 'Today’s odds refresh was already attempted; avoiding repeated charges until next Central day.', creditStatus: meta() }, { headers: { 'Cache-Control': 'private, no-store' } });
  }
  // Never spend new credits twice in the same Central Time calendar day
  // while this Railway process remains alive. The first visit after midnight
  // triggers that day's refresh; a separate scheduler is needed for an exact
  // unattended midnight run.
  if (entry && entry.centralDate === centralDate(now)) return send(entry.payload, false);
  if (!key) {
    if (entry && now - Date.parse(entry.payload.updatedAt) < 48 * 3600000) return send(entry.payload, true, 'API key unavailable. ');
    return NextResponse.json({ props: [], configured: false, message: 'Set ODDS_API_KEY in Railway. Historical research can continue without live odds.', creditStatus: meta() }, { status: 503 });
  }
  resetDailyBudget();
  const settings = config();
  const blocked = now < pausedUntil || spentToday >= settings.dailyBudget || (providerRemaining !== null && providerRemaining <= settings.monthlyReserve);
  if (blocked) {
    if (entry && now - Date.parse(entry.payload.updatedAt) < settings.staleMs) return send(entry.payload, true, 'Requests paused to protect credits. ');
    return NextResponse.json({ props: [], configured: true, message: 'Odds requests paused to protect the daily budget, monthly credit reserve, or during a provider authentication cooldown. Historical data remains separate.', creditStatus: meta() }, { status: 503 });
  }
  try {
    if (!inflight[sport]) {
      // Commit the refresh attempt to persistent storage BEFORE any paid request.
      attempted[sport] = centralDate();
      await persistStore();
      const task = load(sport, key);
      inflight[sport] = task;
      // Remove only this exact request; another visitor may already be awaiting it.
      void task.then(() => { if (inflight[sport] === task) delete inflight[sport]; },
        () => { if (inflight[sport] === task) delete inflight[sport]; });
    }
    const payload = await inflight[sport]!;
    cached[sport] = { payload, centralDate: centralDate() };
    await persistStore();
    return NextResponse.json({ ...payload, stale: false, cached: false, creditStatus: meta() }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    try { await persistStore(); } catch { /* Fail closed on future requests. */ }
    if (entry && now - Date.parse(entry.payload.updatedAt) < settings.staleMs) return send(entry.payload, true, 'Provider request failed. ');
    const status = error instanceof ProviderError ? error.httpStatus : 502;
    return NextResponse.json({ props: [], configured: true, message: error instanceof Error ? error.message : 'Unable to load odds.', creditStatus: meta() }, { status });
  }
}

