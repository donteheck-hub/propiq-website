import { NextRequest, NextResponse } from 'next/server';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { verifiedMembership } from '../../../../lib/server-entitlements';
import { MARKETS, type Prop, type Sport } from '../../../../lib/props';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
const MAX_RECORDS = 12000;
const MAX_PER_SNAPSHOT = 1200;
const RETENTION_MS = 30 * 86400000;
type Sample = {
  sport: Sport; player: string; event: string; commence: string;
  market: string; marketKey: string; side: 'Over' | 'Under';
  bookmaker: string; line: number; odds: number; observedAt: string;
};
type SourceState = { payload?: { props?: unknown; updatedAt?: unknown } };
let writeQueue: Promise<void> = Promise.resolve();

function isProp(p: unknown, sport: Sport): p is Prop {
  if (!p || typeof p !== 'object') return false;
  const v = p as Partial<Prop>;
  return v.source === 'live' && v.sport === sport &&
    typeof v.player === 'string' && v.player.trim().length > 0 && v.player.length < 180 &&
    typeof v.event === 'string' && v.event.length < 300 &&
    typeof v.commence === 'string' && v.commence.length < 80 &&
    typeof v.marketKey === 'string' && !!MARKETS[sport][v.marketKey] &&
    typeof v.market === 'string' && v.market.length < 120 &&
    typeof v.bookmaker === 'string' && v.bookmaker.length < 100 &&
    (v.side === 'Over' || v.side === 'Under') &&
    typeof v.line === 'number' && Number.isFinite(v.line) && v.line >= 0 &&
    typeof v.odds === 'number' && Number.isFinite(v.odds);
}
function isSample(p: unknown): p is Sample {
  if (!p || typeof p !== 'object') return false;
  const s = p as Partial<Sample>;
  return (s.sport === 'NBA' || s.sport === 'NFL') && isProp({ ...s, source: 'live' }, s.sport) &&
    typeof s.observedAt === 'string' && Number.isFinite(Date.parse(s.observedAt));
}
function key(s: Sample) {
  const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, ' ');
  return [s.sport, norm(s.player), norm(s.event), s.commence, s.marketKey, s.side, norm(s.bookmaker), s.observedAt].join('|');
}
async function snapshot(sport: Sport): Promise<Sample[]> {
  const base = process.env.ODDS_CACHE_DIR?.trim();
  if (!base || !path.isAbsolute(base)) throw new Error('Persistent odds storage is not configured.');
  const oddsFile = path.join(base, 'odds-state.json');
  const historyFile = path.join(base, 'line-history-state.json');
  await mkdir(base, { recursive: true });
  // Read the existing cache directly: this NEVER refreshes or bills the odds provider.
  let source: Record<string, SourceState>;
  try { source = JSON.parse(await readFile(oddsFile, 'utf8')) as Record<string, SourceState>; }
  catch { throw new Error('Cached odds are not yet available.'); }
  const payload = source[sport]?.payload;
  const updatedAt = payload?.updatedAt;
  if (typeof updatedAt !== 'string' || !Number.isFinite(Date.parse(updatedAt)) || Date.parse(updatedAt) > Date.now() + 60000 || !Array.isArray(payload.props)) {
    throw new Error('No verified provider snapshot is available yet.');
  }
  let existing: unknown = [];
  try { existing = JSON.parse(await readFile(historyFile, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Could not read persisted line history.'); }
  if (!Array.isArray(existing)) throw new Error('Invalid persisted line history.');
  const expiry = Date.now() - RETENTION_MS;
  const samples = existing.filter((row): row is Sample => isSample(row) && Date.parse(row.observedAt) >= expiry);
  // An entire sport's snapshot is added only if the provider timestamp is newer.
  // Never manufacture movements from visits to an unchanged daily cache.
  if (Date.parse(updatedAt) >= expiry && !samples.some(s => s.sport === sport && s.observedAt === updatedAt)) {
    const additions: Sample[] = payload.props.filter((p: unknown): p is Prop => isProp(p, sport)).slice(0, MAX_PER_SNAPSHOT).map(p => ({
      sport, player: p.player, event: p.event, commence: p.commence,
      market: p.market, marketKey: p.marketKey, side: p.side,
      bookmaker: p.bookmaker, line: p.line, odds: p.odds, observedAt: updatedAt
    }));
    samples.push(...additions);
  }
  const unique = new Map<string, Sample>();
  for (const item of samples) unique.set(key(item), item);
  const result = [...unique.values()].sort((a, b) => a.observedAt.localeCompare(b.observedAt)).slice(-MAX_RECORDS);
  const tmp = `${historyFile}.${process.pid}.${sport}.tmp`;
  await writeFile(tmp, JSON.stringify(result), 'utf8');
  await rename(tmp, historyFile);
  return result.filter(s => s.sport === sport);
}

export async function GET(request: NextRequest) {
  const membership = await verifiedMembership(request);
  if (!membership.available || membership.tier !== 'elite' || !membership.authenticated) {
    return NextResponse.json({ error: 'An active Elite subscription is required.' },
      { status: membership.available ? 403 : 503, headers });
  }
  const requestedSport = request.nextUrl.searchParams.get('sport');
  if (requestedSport !== 'NBA' && requestedSport !== 'NFL') {
    return NextResponse.json({ error: 'Select NBA or NFL.' }, { status: 400, headers });
  }
  const sport: Sport = requestedSport;
  // Serialize read/append/write across concurrent Elite visitors in this process.
  let release!: () => void;
  const previous = writeQueue;
  writeQueue = new Promise<void>(resolve => { release = resolve; });
  await previous.catch(() => undefined);
  try {
    const samples = await snapshot(sport);
    return NextResponse.json({ sport, samples, shared: true, retentionDays: 30 }, { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Line history unavailable.' }, { status: 503, headers });
  } finally { release(); }
}
