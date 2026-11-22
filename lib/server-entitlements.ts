// Server-only authorization. Never trust the client-supplied tier or user ID.
import 'server-only';
import type { NextRequest } from 'next/server';
import { verifyAccount } from './billing';
import { entitlementFromSubscription, type MembershipTier, type SubscriptionRecord } from './entitlements';

export type VerifiedMembership = {
  tier: MembershipTier;
  authenticated: boolean;
  available: boolean;
  currentPeriodEnd: string | null;
};

export async function verifiedMembership(request: NextRequest): Promise<VerifiedMembership> {
  const user = await verifyAccount(request);
  if (!user) return { tier: 'free', authenticated: false, available: true, currentPeriodEnd: null };

  const base = process.env.SUPABASE_URL?.trim().replace(/\/$/, '');
  const key = process.env.SUPABASE_ANON_KEY?.trim();
  const denied = { tier: 'free' as const, authenticated: true, available: false, currentPeriodEnd: null };
  if (!base || !key || !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(base)) return denied;

  try {
    const res = await fetch(
      `${base}/rest/v1/propiq_subscriptions?user_id=eq.${encodeURIComponent(user.id)}&select=plan,status,current_period_end&limit=1`,
      {
        headers: { apikey: key, authorization: `Bearer ${user.token}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(9000)
      }
    );
    if (!res.ok) return denied;
    const data: unknown = await res.json();
    const row = Array.isArray(data) ? data[0] as SubscriptionRecord | undefined : undefined;
    const tier = entitlementFromSubscription(row);
    return {
      tier, authenticated: true, available: true,
      currentPeriodEnd: tier !== 'free' && typeof row?.current_period_end === 'string' ? row.current_period_end : null
    };
  } catch {
    return denied;
  }
}
