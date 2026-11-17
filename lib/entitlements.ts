export type MembershipTier = 'free' | 'pro' | 'elite';
export type SubscriptionRecord = {
  plan?: unknown;
  status?: unknown;
  current_period_end?: unknown;
};

// Only the server calls this after verifying the user's session and querying
// their own subscription under Supabase RLS. Bad or missing data denies access.
export function entitlementFromSubscription(row: SubscriptionRecord | undefined, now = Date.now()): MembershipTier {
  if (!row) return 'free';
  if (row.status !== 'active' && row.status !== 'trialing') return 'free';
  if (row.plan !== 'pro' && row.plan !== 'elite') return 'free';
  if (typeof row.current_period_end !== 'string') return 'free';
  const expires = Date.parse(row.current_period_end);
  if (!Number.isFinite(expires) || expires <= now) return 'free';
  return row.plan;
}
