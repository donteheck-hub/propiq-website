// Billing is intentionally limited to Stripe TEST MODE. No live charges.
import type { NextRequest } from 'next/server';

export const billingEnabled = () => process.env.BILLING_TEST_MODE_ENABLED === 'true' &&
  (process.env.STRIPE_SECRET_KEY || '').startsWith('sk_test_');

export function stripeKey() { return process.env.STRIPE_SECRET_KEY?.trim() || ''; }

export function sameOrigin(request: NextRequest) {
  const value = request.headers.get('origin');
  if (!value) return false;
  try {
    const url = new URL(value);
    if (url.origin !== value || (process.env.NODE_ENV === 'production' && url.protocol !== 'https:')) return false;
    const allowed = process.env.AUTH_ALLOWED_ORIGIN?.trim();
    if (allowed) return value === allowed;
    return [request.headers.get('host'), request.headers.get('x-forwarded-host')]
      .filter((host): host is string => Boolean(host) && !host!.includes(','))
      .some(host => host.toLowerCase() === url.host.toLowerCase());
  } catch { return false; }
}

export async function verifyAccount(request: NextRequest): Promise<{id: string; email: string; token: string} | null> {
  const base = process.env.SUPABASE_URL?.trim().replace(/\/$/, '');
  const key = process.env.SUPABASE_ANON_KEY?.trim();
  const token = request.cookies.get('propiq-access')?.value;
  if (!base || !key || !token || !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(base)) return null;
  try {
    const res = await fetch(`${base}/auth/v1/user`, {
      headers: { apikey: key, authorization: `Bearer ${token}` }, cache: 'no-store', signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return null;
    const user = await res.json() as { id?: unknown; email?: unknown; email_confirmed_at?: unknown };
    if (typeof user.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(user.id) || typeof user.email !== 'string' || !user.email_confirmed_at) return null;
    return { id: user.id, email: user.email, token };
  } catch { return null; }
}

export function planPrice(plan: string) {
  if (plan === 'pro') return process.env.STRIPE_TEST_PRO_PRICE_ID?.trim() || '';
  if (plan === 'elite') return process.env.STRIPE_TEST_ELITE_PRICE_ID?.trim() || '';
  return '';
}

export function stripeApi(endpoint: string, body: URLSearchParams) {
  return fetch(`https://api.stripe.com/v1/${endpoint}`, {
    method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(15000),
    headers: { authorization: `Bearer ${stripeKey()}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
}
