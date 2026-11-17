import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const result = (message: string, status = 200) => NextResponse.json({message}, {status});
type StripeEvent = {id?: string; type?: string; created?: number; livemode?: boolean; data?: {object?: Record<string, unknown>}};

function verified(body: string, header: string, secret: string) {
  const parts = header.split(',').map(p => p.trim());
  const timestamp = parts.find(p => p.startsWith('t='))?.slice(2);
  const signatures = parts.filter(p => p.startsWith('v1=')).map(p => p.slice(3));
  const time = Number(timestamp);
  if (!timestamp || !Number.isSafeInteger(time) || Math.abs(Date.now()/1000 - time) > 300 || !signatures.length) return false;
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return signatures.some(sig => /^[0-9a-f]{64}$/i.test(sig) && timingSafeEqual(Buffer.from(sig,'hex'), Buffer.from(digest,'hex')));
}

export async function POST(request: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET || '';
  const base = process.env.SUPABASE_URL?.trim().replace(/\/$/,'');
  const admin = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_') || process.env.BILLING_TEST_MODE_ENABLED !== 'true' || !secret.startsWith('whsec_') || !base || !admin) return result('Test webhook not configured.', 503);
  if (Number(request.headers.get('content-length') || 0) > 1000000) return result('Too large', 413);
  const body = await request.text();
  if (body.length > 1000000 || !verified(body, request.headers.get('stripe-signature') || '', secret)) return result('Invalid Stripe signature', 400);
  let event: StripeEvent;
  try { event = JSON.parse(body) as StripeEvent; } catch { return result('Invalid JSON', 400); }
  if (!event.id || !/^evt_[a-zA-Z0-9]+$/.test(event.id) || !Number.isSafeInteger(event.created) || event.livemode !== false) return result('Invalid test event',400);
  const object = event.data?.object || {};
  if (!['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted'].includes(event.type || '')) return result('Event ignored');
  if (object.object !== 'subscription') return result('Invalid subscription object',400);
  const meta = object.metadata as {user_id?: string;plan?:string}|undefined;
  const userId = meta?.user_id;
  const plan = meta?.plan;
  const subscriptionId = object.id;
  const customerId = object.customer;
  const status = object.status;
  if (typeof userId !== 'string' || !/^[0-9a-f-]{36}$/i.test(userId) || (plan !== 'pro' && plan !== 'elite') ||
      typeof subscriptionId !== 'string' || !subscriptionId.startsWith('sub_') || typeof customerId !== 'string' || !customerId.startsWith('cus_') || typeof status !== 'string') return result('Subscription event missing required metadata', 400);
  const itemData = object.items as { data?: {current_period_end?: number}[] } | undefined;
  const period = itemData?.data?.[0]?.current_period_end;
  const at = new Date(Number(event.created) * 1000).toISOString();
  const payload = {
    user_id:userId, plan, status, stripe_subscription_id:subscriptionId, stripe_customer_id:customerId,
    current_period_end:typeof period==='number' ? new Date(period*1000).toISOString():null,
    last_event_at:at, last_event_id:event.id
  };
  try {
    // A database upsert is atomic and ignores older webhook events (via RPC).
    const response = await fetch(`${base}/rest/v1/rpc/propiq_update_subscription`, {
      method:'POST', cache:'no-store', signal:AbortSignal.timeout(12000),
      headers:{apikey:admin,authorization:`Bearer ${admin}`,'content-type':'application/json'},
      body:JSON.stringify({p_user_id:userId,p_plan:plan,p_status:status,p_subscription_id:subscriptionId,p_customer_id:customerId,p_period_end:payload.current_period_end,p_event_at:at,p_event_id:event.id})
    });
    if (!response.ok) { console.error('PropIQ billing webhook database error',response.status); return result('Database update failed',503); }
    return result('Recorded');
  } catch { return result('Database unavailable',503); }
}
