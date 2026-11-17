import { NextRequest, NextResponse } from 'next/server';
import { verifyAccount } from '../../../lib/billing';
import { entitlementFromSubscription, type SubscriptionRecord } from '../../../lib/entitlements';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const reply = (data: object, status = 200) => NextResponse.json(data, {
  status, headers: { 'Cache-Control': 'private, no-store, max-age=0' }
});

// Fail closed: never infer permissions from the browser, price ID, or a plan label alone.
export async function GET(request: NextRequest) {
  const user = await verifyAccount(request);
  if (!user) return reply({ tier: 'free', authenticated: false });

  const base = process.env.SUPABASE_URL?.trim().replace(/\/$/, '');
  const anonKey = process.env.SUPABASE_ANON_KEY?.trim();
  if (!base || !anonKey) return reply({ tier: 'free', authenticated: true, notice: 'Membership verification is unavailable.' });

  try {
    const response = await fetch(
      `${base}/rest/v1/propiq_subscriptions?user_id=eq.${encodeURIComponent(user.id)}&select=plan,status,current_period_end&limit=1`,
      {
        headers: { apikey: anonKey, authorization: `Bearer ${user.token}` },
        cache: 'no-store', signal: AbortSignal.timeout(9000)
      }
    );
    if (!response.ok) return reply({ tier: 'free', authenticated: true, notice: 'Membership verification is unavailable.' });
    const data: unknown = await response.json();
    const row = Array.isArray(data) ? data[0] as SubscriptionRecord | undefined : undefined;
    const tier = entitlementFromSubscription(row);
    return reply({ tier, authenticated: true, currentPeriodEnd: tier === 'free' ? null : row?.current_period_end ?? null });
  } catch {
    return reply({ tier: 'free', authenticated: true, notice: 'Membership verification is temporarily unavailable.' });
  }
}
