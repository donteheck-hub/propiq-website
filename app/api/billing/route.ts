import { NextRequest, NextResponse } from 'next/server';
import { billingEnabled, planPrice, stripeApi, verifyAccount } from '../../../lib/billing';
import { entitlementFromSubscription, type SubscriptionRecord } from '../../../lib/entitlements';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const reply = (data: object, status = 200) => NextResponse.json(data, { status, headers: {'Cache-Control':'private, no-store', 'Vary':'Cookie'} });

// Use one explicitly configured public origin, not proxy-supplied host headers.
function trustedOrigin(request: NextRequest) {
  const configured = process.env.BILLING_SITE_URL?.trim();
  const origin = request.headers.get('origin');
  if (!configured || !origin) return false;
  try {
    const site = new URL(configured);
    return site.protocol === 'https:' && site.origin === configured && origin === site.origin;
  } catch { return false; }
}

async function subscriptionFor(user: {id:string; token:string}): Promise<{row: SubscriptionRecord | undefined; ok: boolean}> {
  const base = process.env.SUPABASE_URL?.trim().replace(/\/$/, '');
  const key = process.env.SUPABASE_ANON_KEY?.trim();
  if (!base || !key) return {row:undefined, ok:false};
  try {
    const res = await fetch(`${base}/rest/v1/propiq_subscriptions?user_id=eq.${encodeURIComponent(user.id)}&select=plan,status,current_period_end&limit=1`, {
      headers:{apikey:key, authorization:`Bearer ${user.token}`}, cache:'no-store', signal:AbortSignal.timeout(9000)
    });
    if (!res.ok) return {row:undefined, ok:false};
    const data: unknown = await res.json();
    return {row: Array.isArray(data) ? data[0] as SubscriptionRecord | undefined : undefined, ok:true};
  } catch { return {row:undefined, ok:false}; }
}

export async function GET(request: NextRequest) {
  const enabled = billingEnabled() && Boolean(planPrice('pro')) && Boolean(planPrice('elite')) &&
    Boolean(process.env.STRIPE_WEBHOOK_SECRET?.startsWith('whsec_')) && Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const user = await verifyAccount(request);
  if (!user) return reply({ enabled, authenticated: false, plan: 'free' });
  const membership = await subscriptionFor(user);
  if (!membership.ok) return reply({enabled, authenticated:true, plan:'free', notice:'Membership status could not be verified.'}, 503);
  const tier = entitlementFromSubscription(membership.row);
  return reply({enabled, authenticated:true, plan:tier, currentPeriodEnd:tier === 'free' ? null : membership.row?.current_period_end ?? null});
}

export async function POST(request: NextRequest) {
  if (!trustedOrigin(request)) return reply({ error:'Invalid request origin.' }, 403);
  if (!billingEnabled() || !process.env.STRIPE_WEBHOOK_SECRET?.startsWith('whsec_') || !process.env.SUPABASE_SERVICE_ROLE_KEY) return reply({ error:'Stripe TEST checkout is not configured. No charges were made.' }, 503);
  const user = await verifyAccount(request);
  if (!user) return reply({ error:'Sign in with a verified email before testing checkout.' }, 401);
  let plan = '';
  try { plan = (await request.json() as {plan?:unknown}).plan as string; } catch { return reply({ error:'Invalid request.' }, 400); }
  // Prevent a second subscription or an accidental double charge for an already active account.
  const membership = await subscriptionFor(user);
  if (!membership.ok) return reply({error:'Unable to verify existing membership. Try again later.'}, 503);
  if (entitlementFromSubscription(membership.row) !== 'free') return reply({error:'This account already has an active test subscription. Manage it before buying another.'}, 409);
  const price = planPrice(plan);
  if (!price || !/^price_[a-zA-Z0-9]+$/.test(price)) return reply({ error:'This test plan has no valid Stripe price ID.' }, 400);
  const site = process.env.BILLING_SITE_URL?.trim();
  if (!site || !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/.test(site)) return reply({error:'BILLING_SITE_URL must be a complete HTTPS website URL.'}, 503);
  const body = new URLSearchParams({
    mode:'subscription', 'line_items[0][price]':price, 'line_items[0][quantity]':'1',
    customer_email:user.email, client_reference_id:user.id,
    'metadata[user_id]':user.id, 'metadata[plan]':plan,
    'subscription_data[metadata][user_id]':user.id,
    'subscription_data[metadata][plan]':plan,
    success_url:`${site}/?billing=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:`${site}/?billing=cancelled`
  });
  try {
    const response = await stripeApi('checkout/sessions', body);
    const result = await response.json() as { url?: string; error?: {message?: string} };
    if (!response.ok || !result.url || !result.url.startsWith('https://checkout.stripe.com/')) {
      console.error('PropIQ Stripe test checkout error HTTP', response.status);
      return reply({error:'Stripe test checkout could not start. Verify test price IDs.'}, 502);
    }
    return reply({url:result.url});
  } catch { return reply({error:'Stripe test checkout temporarily unavailable.'}, 503); }
}
