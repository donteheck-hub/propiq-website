-- Run in Supabase SQL Editor for the PropIQ project.
-- Each authenticated user can read/write only their own bookmarks.
create table if not exists public.propiq_saved_props (
  user_id uuid primary key references auth.users(id) on delete cascade,
  saved_keys jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  constraint propiq_saved_props_array check (jsonb_typeof(saved_keys) = 'array')
);
alter table public.propiq_saved_props enable row level security;
revoke all on public.propiq_saved_props from anon;
grant select, insert, update on public.propiq_saved_props to authenticated;

drop policy if exists "Users read own PropIQ bookmarks" on public.propiq_saved_props;
create policy "Users read own PropIQ bookmarks" on public.propiq_saved_props
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Users insert own PropIQ bookmarks" on public.propiq_saved_props;
create policy "Users insert own PropIQ bookmarks" on public.propiq_saved_props
  for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "Users update own PropIQ bookmarks" on public.propiq_saved_props;
create policy "Users update own PropIQ bookmarks" on public.propiq_saved_props
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
