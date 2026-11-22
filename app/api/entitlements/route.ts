import { NextRequest, NextResponse } from 'next/server';
import { verifiedMembership } from '../../../lib/server-entitlements';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const membership = await verifiedMembership(request);
  return NextResponse.json({
    tier: membership.tier,
    authenticated: membership.authenticated,
    currentPeriodEnd: membership.currentPeriodEnd,
    ...(!membership.available ? {notice: 'Membership verification is temporarily unavailable.'} : {})
  }, {
    headers: { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Cookie' }
  });
}
