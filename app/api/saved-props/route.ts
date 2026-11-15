import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_SAVED = 300;
const ACCESS_COOKIE = 'propiq-access';
const noStore = { 'Cache-Control': 'private, no-store' };
const reply = (body: object, status = 200) => NextResponse.json(body, { status, headers: noStore });

function config() {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/$/, '');
  const key = process.env.SUPABASE_ANON_KEY?.trim();
  if (!url || !key) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.supabase.co')) return null;
    return { url, key };
  } catch { return null; }
}

function originMatches(request: NextRequest): boolean {
  const header = request.headers.get('origin');
  if (!header) return false;
  try {
    const origin = new URL(header);
    if (origin.origin !== header || (process.env.NODE_ENV === 'production' && origin.protocol !== 'https:')) return false;
    const configured = process.env.AUTH_ALLOWED_ORIGIN?.trim();
    if (configured) return origin.origin === configured;
    const hosts = [request.headers.get('host'), request.headers.get('x-forwarded-host')]
      .filter((host): host is string => Boolean(host) && !host!.includes(','));
    return hosts.some(host => host.toLowerCase() === origin.host.toLowerCase());
  } catch { return false; }
}

type Context = { cfg: { url: string; key: string }; token: string; userId: string };
async function context(request: NextRequest): Promise<Context | NextResponse> {
  const cfg = config();
  if (!cfg) return reply({ error: 'Supabase is not configured.' }, 503);
  const token = request.cookies.get(ACCESS_COOKIE)?.value;
  if (!token) return reply({ error: 'Sign in to save props in your account.' }, 401);
  try {
    // Check the token with Supabase, not with unverified JWT contents.
    const res = await fetch(`${cfg.url}/auth/v1/user`, {
      headers: { apikey: cfg.key, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000), cache: 'no-store'
    });
    if (!res.ok) return reply({ error: 'Session expired. Sign in again.' }, 401);
    const data = await res.json() as { id?: unknown };
    if (typeof data.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(data.id)) return reply({ error: 'Invalid account.' }, 401);
    return { cfg, token, userId: data.id };
  } catch { return reply({ error: 'Cannot verify your account right now.' }, 503); }
}

function headers(ctx: Context): Record<string, string> {
  return { apikey: ctx.cfg.key, Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' };
}
function validKeys(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_SAVED &&
    value.every(v => typeof v === 'string' && v.length > 0 && v.length <= 512) &&
    new Set(value).size === value.length;
}

export async function GET(request: NextRequest) {
  const ctx = await context(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const response = await fetch(`${ctx.cfg.url}/rest/v1/propiq_saved_props?user_id=eq.${encodeURIComponent(ctx.userId)}&select=saved_keys`, {
      headers: headers(ctx), cache: 'no-store', signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) {
      console.error('PropIQ saved props read failed, Supabase status', response.status);
      return reply({ error: 'Could not load cloud bookmarks. Check the database setup.' }, 503);
    }
    const rows = await response.json() as { saved_keys?: unknown }[];
    const saved = rows[0]?.saved_keys ?? [];
    if (!validKeys(saved)) return reply({ error: 'Invalid cloud bookmark data.' }, 502);
    return reply({ saved });
  } catch { return reply({ error: 'Cloud bookmarks are temporarily unavailable.' }, 503); }
}

export async function PUT(request: NextRequest) {
  if (!originMatches(request)) return reply({ error: 'Invalid request origin.' }, 403);
  const ctx = await context(request);
  if (ctx instanceof NextResponse) return ctx;
  if (Number(request.headers.get('content-length') || '0') > 160000) return reply({ error: 'Request too large.' }, 413);
  let saved: unknown;
  try { saved = (await request.json() as { saved?: unknown }).saved; }
  catch { return reply({ error: 'Invalid request body.' }, 400); }
  if (!validKeys(saved)) return reply({ error: `Provide up to ${MAX_SAVED} unique bookmark keys.` }, 400);
  try {
    const response = await fetch(`${ctx.cfg.url}/rest/v1/propiq_saved_props?on_conflict=user_id`, {
      method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(10000),
      headers: { ...headers(ctx), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ user_id: ctx.userId, saved_keys: saved })
    });
    if (!response.ok) {
      console.error('PropIQ saved props write failed, Supabase status', response.status);
      return reply({ error: 'Could not save bookmarks. Check your database permissions.' }, 503);
    }
    return reply({ saved });
  } catch { return reply({ error: 'Cloud bookmarks are temporarily unavailable.' }, 503); }
}
