import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ACCESS = 'propiq-access';
const REFRESH = 'propiq-refresh';
const commonHeaders = { 'Cache-Control': 'no-store' };
type Identity = { id: string; email: string };
type AuthResponse = { access_token?: string; refresh_token?: string; expires_in?: number; user?: { id?: string; email?: string }; error_description?: string; msg?: string; message?: string; error?: string };

function settings() {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/$/, '');
  const key = process.env.SUPABASE_ANON_KEY?.trim();
  if (!url || !key) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.supabase.co')) return null;
    return { base: `${url}/auth/v1`, key };
  } catch { return null; }
}
function publicUser(value: AuthResponse['user']): Identity | null {
  return value?.id && value.email ? { id: value.id, email: value.email } : null;
}
function json(data: object, status = 200) {
  return NextResponse.json(data, { status, headers: commonHeaders });
}
function setAuthCookies(response: NextResponse, data: AuthResponse) {
  if (!data.access_token || !data.refresh_token) return;
  const secure = process.env.NODE_ENV === 'production';
  response.cookies.set(ACCESS, data.access_token, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: Math.max(60, Math.min(data.expires_in ?? 3600, 86400)) });
  response.cookies.set(REFRESH, data.refresh_token, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: 30 * 24 * 3600 });
}
function clearCookies(response: NextResponse) {
  response.cookies.delete(ACCESS);
  response.cookies.delete(REFRESH);
}
async function authFetch(path: string, method: string, payload?: object, accessToken?: string) {
  const config = settings();
  if (!config) return { status: 503, data: { error: 'Account service is not configured.' } as AuthResponse };
  const response = await fetch(`${config.base}${path}`, {
    method, cache: 'no-store', signal: AbortSignal.timeout(12000),
    headers: { 'apikey': config.key, 'Authorization': `Bearer ${accessToken || config.key}`, 'Content-Type': 'application/json' },
    ...(payload ? { body: JSON.stringify(payload) } : {})
  });
  const data = await response.json().catch(() => ({})) as AuthResponse;
  return { status: response.status, data };
}
function providerError(data: AuthResponse) {
  return data.error_description || data.msg || data.message || data.error || 'Account request failed.';
}
function sameOrigin(request: NextRequest) {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try { return new URL(origin).host === request.nextUrl.host && new URL(origin).protocol === request.nextUrl.protocol; } catch { return false; }
}
export async function GET(request: NextRequest) {
  if (!settings()) return json({ configured: false, user: null });
  try {
    const access = request.cookies.get(ACCESS)?.value;
    if (access) {
      const result = await authFetch('/user', 'GET', undefined, access);
      if (result.status === 200) return json({ configured: true, user: publicUser(result.data as AuthResponse['user']) });
    }
    const refresh = request.cookies.get(REFRESH)?.value;
    if (!refresh) return json({ configured: true, user: null });
    const result = await authFetch('/token?grant_type=refresh_token', 'POST', { refresh_token: refresh });
    if (result.status !== 200 || !result.data.access_token) {
      const response = json({ configured: true, user: null }); clearCookies(response); return response;
    }
    const response = json({ configured: true, user: publicUser(result.data.user) });
    setAuthCookies(response, result.data);
    return response;
  } catch { return json({ configured: true, user: null, error: 'Account service temporarily unavailable.' }, 503); }
}
export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return json({ error: 'Invalid request origin.' }, 403);
  if (!settings()) return json({ error: 'Configure your Supabase project first.' }, 503);
  if (Number(request.headers.get('content-length') || '0') > 4096) return json({ error: 'Request too large.' }, 413);
  try {
    const body = await request.json() as { action?: unknown; email?: unknown; password?: unknown };
    const action = body.action;
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = body.password;
    if (action !== 'login' && action !== 'signup') return json({ error: 'Invalid action.' }, 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || typeof password !== 'string' || password.length < 6 || password.length > 72) return json({ error: 'Enter a valid email and password (6–72 characters).' }, 400);
    const result = action === 'signup'
      ? await authFetch('/signup', 'POST', { email, password })
      : await authFetch('/token?grant_type=password', 'POST', { email, password });
    if (result.status < 200 || result.status >= 300) return json({ error: providerError(result.data) }, result.status === 429 ? 429 : 400);
    if (!result.data.access_token) return json({ needsConfirmation: true, message: 'Check your email to confirm your account.' });
    const response = json({ user: publicUser(result.data.user) });
    setAuthCookies(response, result.data);
    return response;
  } catch { return json({ error: 'Account service unavailable. Please try again.' }, 502); }
}
export async function DELETE(request: NextRequest) {
  if (!sameOrigin(request)) return json({ error: 'Invalid request origin.' }, 403);
  const access = request.cookies.get(ACCESS)?.value;
  if (access) { try { await authFetch('/logout', 'POST', undefined, access); } catch { /* Still end the local session */ } }
  const response = json({ message: 'Signed out.' });
  clearCookies(response);
  return response;
}
