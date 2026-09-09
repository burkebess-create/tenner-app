-- 2026-09-09 — Moderation, photo storage, marketing channels, ban enforcement
--
-- NOTE: these statements were applied to the live database during the
-- 2026-09-08/09 working session. This file records them so the repo stays a
-- faithful description of the schema. Everything here is idempotent and safe
-- to re-run against a database that already has it.

-- ─────────────────────────────────────────────────────────────────────
-- 1. Analytics events
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.analytics_events (
  id         bigserial primary key,
  user_id    uuid null references auth.users(id) on delete set null,
  event      text not null,
  meta       jsonb null,
  session_id text null,
  user_agent text null,
  referer    text null,
  created_at timestamptz not null default now()
);
create index if not exists idx_analytics_events_event_created on public.analytics_events(event, created_at desc);
create index if not exists idx_analytics_events_user_created  on public.analytics_events(user_id, created_at desc);
alter table public.analytics_events enable row level security;

drop policy if exists analytics_events_insert_any on public.analytics_events;
create policy analytics_events_insert_any on public.analytics_events
  for insert to anon, authenticated with check (true);

drop policy if exists analytics_events_admin_select on public.analytics_events;
create policy analytics_events_admin_select on public.analytics_events
  for select to authenticated
  using (exists (select 1 from public.admins where user_id = auth.uid()));

-- ─────────────────────────────────────────────────────────────────────
-- 2. Content reports (user-submitted moderation queue)
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.content_reports (
  id             bigserial primary key,
  kind           text not null check (kind in ('comment','list_item','list','user','group')),
  target_id      text not null,
  target_owner   uuid null references auth.users(id) on delete set null,
  target_context jsonb null,
  reporter_id    uuid not null references auth.users(id) on delete cascade,
  reason         text not null,
  detail         text null,
  status         text not null default 'pending' check (status in ('pending','reviewing','resolved','dismissed')),
  resolution     text null,
  resolved_at    timestamptz null,
  resolved_by    uuid null references auth.users(id) on delete set null,
  created_at     timestamptz not null default now()
);
create index if not exists idx_content_reports_status_created on public.content_reports(status, created_at desc);
create index if not exists idx_content_reports_kind_target    on public.content_reports(kind, target_id);
create index if not exists idx_content_reports_reporter       on public.content_reports(reporter_id, created_at desc);
alter table public.content_reports enable row level security;

drop policy if exists content_reports_insert_own on public.content_reports;
create policy content_reports_insert_own on public.content_reports
  for insert to authenticated with check (reporter_id = auth.uid());

drop policy if exists content_reports_select_own on public.content_reports;
create policy content_reports_select_own on public.content_reports
  for select to authenticated using (reporter_id = auth.uid());

drop policy if exists content_reports_admin_select on public.content_reports;
create policy content_reports_admin_select on public.content_reports
  for select to authenticated
  using (exists (select 1 from public.admins where user_id = auth.uid()));

drop policy if exists content_reports_admin_update on public.content_reports;
create policy content_reports_admin_update on public.content_reports
  for update to authenticated
  using  (exists (select 1 from public.admins where user_id = auth.uid()))
  with check (exists (select 1 from public.admins where user_id = auth.uid()));

-- ─────────────────────────────────────────────────────────────────────
-- 3. Photos storage bucket (profile + group photos moved out of base64)
-- ─────────────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', true, 2097152, array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists photos_own_avatar_insert on storage.objects;
create policy photos_own_avatar_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'photos' and (
      (split_part(name,'/',1) = 'avatars' and split_part(name,'/',2) = auth.uid()::text)
      or split_part(name,'/',1) = 'groups'
    )
  );

drop policy if exists photos_own_avatar_update on storage.objects;
create policy photos_own_avatar_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'photos' and (
      (split_part(name,'/',1) = 'avatars' and split_part(name,'/',2) = auth.uid()::text)
      or split_part(name,'/',1) = 'groups'
    )
  );

drop policy if exists photos_own_avatar_delete on storage.objects;
create policy photos_own_avatar_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'photos' and (
      (split_part(name,'/',1) = 'avatars' and split_part(name,'/',2) = auth.uid()::text)
      or split_part(name,'/',1) = 'groups'
    )
  );

drop policy if exists photos_public_read on storage.objects;
create policy photos_public_read on storage.objects
  for select to public using (bucket_id = 'photos');

-- ─────────────────────────────────────────────────────────────────────
-- 4. Marketing channel accounts (?ch=instagram -> invite leaderboard)
-- ─────────────────────────────────────────────────────────────────────
alter table public.profiles add column if not exists is_system boolean not null default false;
create index if not exists idx_profiles_is_system on public.profiles(is_system) where is_system;

-- IMPORTANT: banned_until must be a FINITE far-future timestamp. GoTrue scans
-- this column into a Go time.Time, which cannot represent Postgres 'infinity';
-- setting it makes every auth request for that user fail with
-- "Database error querying schema".
do $$
declare v_id uuid := '00000000-0000-4000-8000-000000000001';
begin
  if not exists (select 1 from auth.users where id = v_id) then
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      created_at, updated_at, raw_app_meta_data, raw_user_meta_data, banned_until
    ) values (
      '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated',
      'instagram@channels.mytenner.com',
      '$2a$10$SYSTEMACCOUNTNOLOGINPOSSIBLEXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      now(), now(), now(),
      '{"provider":"system","providers":["system"]}'::jsonb,
      '{"system_channel":"instagram"}'::jsonb,
      '2999-12-31 23:59:59+00'::timestamptz
    );
  end if;
  insert into public.profiles (id, display_name, handle, email, is_system, created_at)
  values (v_id, 'Tenner on Instagram', 'instagram', 'instagram@channels.mytenner.com', true, now())
  on conflict (id) do update
    set display_name = excluded.display_name,
        handle       = excluded.handle,
        is_system    = true;
end $$;

-- ─────────────────────────────────────────────────────────────────────
-- 5. Ban enforcement at the database layer
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.actor_not_banned()
returns boolean language sql stable security definer set search_path = public
as $$
  select not coalesce((select p.is_banned from public.profiles p where p.id = auth.uid()), false);
$$;
grant execute on function public.actor_not_banned() to authenticated, anon;

create or replace function public.guard_moderation_columns()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if (new.is_banned     is distinct from old.is_banned
   or new.banned_at     is distinct from old.banned_at
   or new.banned_reason is distinct from old.banned_reason
   or new.is_system     is distinct from old.is_system)
     and auth.uid() is not null
     and not exists (select 1 from public.admins a where a.user_id = auth.uid())
  then
    raise exception 'moderation_fields_are_admin_only';
  end if;
  return new;
end $$;

drop trigger if exists trg_guard_moderation_columns on public.profiles;
create trigger trg_guard_moderation_columns
  before update on public.profiles
  for each row execute function public.guard_moderation_columns();

drop policy if exists lists_insert on public.lists;
create policy lists_insert on public.lists
  for insert to authenticated
  with check (user_id = auth.uid() and public.actor_not_banned());

drop policy if exists lists_update on public.lists;
create policy lists_update on public.lists
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.actor_not_banned());

drop policy if exists "Insert comment if owner allows" on public.list_item_comments;
create policy "Insert comment if owner allows" on public.list_item_comments
  for insert to authenticated
  with check (
    auth.uid() = from_user_id
    and public.actor_not_banned()
    and (
      list_owner_id = auth.uid()
      or exists (
        select 1 from public.profiles p
        where p.id = list_item_comments.list_owner_id
          and coalesce(p.allow_comments_on_my_lists, true) = true
      )
    )
  );

drop policy if exists "Update own comments" on public.list_item_comments;
create policy "Update own comments" on public.list_item_comments
  for update to authenticated
  using (auth.uid() = from_user_id)
  with check (auth.uid() = from_user_id and public.actor_not_banned());

drop policy if exists friendships_insert on public.friendships;
create policy friendships_insert on public.friendships
  for insert to authenticated
  with check (requester_id = auth.uid() and public.actor_not_banned());

drop policy if exists groups_insert on public.groups;
create policy groups_insert on public.groups
  for insert to authenticated
  with check (created_by = auth.uid() and public.actor_not_banned());

-- Repair any rows already set to the unusable 'infinity' value.
update auth.users
   set banned_until = '2999-12-31 23:59:59+00'::timestamptz
 where banned_until = 'infinity'::timestamptz;
