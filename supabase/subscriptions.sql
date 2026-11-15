-- Run in Supabase SQL Editor. Never expose service_role to the browser.
create table if not exists public.propiq_subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan text not null check (plan in ('pro','elite')),
  status text not null,
  stripe_subscription_id text not null,
  stripe_customer_id text not null,
  current_period_end timestamptz,
  last_event_at timestamptz not null,
  last_event_id text not null
);
alter table public.propiq_subscriptions enable row level security;
revoke all on public.propiq_subscriptions from anon;
grant select on public.propiq_subscriptions to authenticated;
drop policy if exists "Users see own subscription" on public.propiq_subscriptions;
create policy "Users see own subscription" on public.propiq_subscriptions
  for select to authenticated using (auth.uid() = user_id);

-- Webhooks use service-role credentials and this atomic monotonic upsert.
create or replace function public.propiq_update_subscription(
  p_user_id uuid, p_plan text, p_status text, p_subscription_id text, p_customer_id text,
  p_period_end timestamptz, p_event_at timestamptz, p_event_id text
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_plan not in ('pro','elite') or p_subscription_id !~ '^sub_' then
    raise exception 'Invalid subscription';
  end if;
  insert into public.propiq_subscriptions as s
    (user_id,plan,status,stripe_subscription_id,stripe_customer_id,current_period_end,last_event_at,last_event_id)
  values (p_user_id,p_plan,p_status,p_subscription_id,p_customer_id,p_period_end,p_event_at,p_event_id)
  on conflict (user_id) do update set
    plan = excluded.plan, status = excluded.status,
    stripe_subscription_id = excluded.stripe_subscription_id,
    stripe_customer_id = excluded.stripe_customer_id,
    current_period_end = excluded.current_period_end,
    last_event_at = excluded.last_event_at,
    last_event_id = excluded.last_event_id
  where s.last_event_at < excluded.last_event_at;
end; $$;
revoke execute on function public.propiq_update_subscription(uuid,text,text,text,text,timestamptz,timestamptz,text) from public, anon, authenticated;
grant execute on function public.propiq_update_subscription(uuid,text,text,text,text,timestamptz,timestamptz,text) to service_role;
