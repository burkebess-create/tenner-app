-- 2026-09-09 — Admin RPCs added during the moderation / analytics session.
-- Applied live via MCP; recorded here so the repo matches the database.
-- Safe to re-run.

-- ── Error dashboard ──────────────────────────────────────────────────
create or replace function public.admin_get_error_summary(days integer default 7)
returns table (
  message text, hits bigint, users bigint,
  first_seen timestamptz, last_seen timestamptz,
  sample_stack text, sample_path text
)
language sql security definer set search_path = public stable
as $$
  with recent as (
    select
      coalesce(nullif(meta->>'message',''), '(no message)') as message,
      user_id, created_at,
      meta->>'stack' as stack, meta->>'pathname' as pathname
    from analytics_events
    where event = 'js_error'
      and created_at >= now() - make_interval(days => greatest(days,1))
      and exists (select 1 from admins where user_id = auth.uid())
  )
  select message, count(*)::bigint, count(distinct user_id)::bigint,
         min(created_at), max(created_at),
         (array_agg(stack    order by created_at desc) filter (where stack    is not null))[1],
         (array_agg(pathname order by created_at desc) filter (where pathname is not null))[1]
  from recent group by message
  order by 2 desc, 5 desc limit 200;
$$;
grant execute on function public.admin_get_error_summary(integer) to authenticated;

-- ── Reports queue ────────────────────────────────────────────────────
create or replace function public.admin_get_reports(p_status text default 'pending', p_limit int default 100)
returns setof public.content_reports
language sql security definer set search_path = public stable
as $$
  select r.* from content_reports r
  where exists (select 1 from admins where user_id = auth.uid())
    and (p_status is null or p_status = 'all' or r.status = p_status)
  order by (r.status = 'pending') desc, r.created_at desc
  limit greatest(p_limit, 1);
$$;
grant execute on function public.admin_get_reports(text, int) to authenticated;

create or replace function public.admin_get_reports_counts()
returns table (pending bigint, reviewing bigint, resolved bigint, dismissed bigint)
language sql security definer set search_path = public stable
as $$
  select
    count(*) filter (where status = 'pending'),
    count(*) filter (where status = 'reviewing'),
    count(*) filter (where status = 'resolved'),
    count(*) filter (where status = 'dismissed')
  from content_reports
  where exists (select 1 from admins where user_id = auth.uid());
$$;
grant execute on function public.admin_get_reports_counts() to authenticated;

create or replace function public.admin_resolve_report(p_id bigint, p_status text, p_resolution text default null)
returns void language plpgsql security definer set search_path = public
as $$
begin
  if not exists (select 1 from admins where user_id = auth.uid()) then raise exception 'not_admin'; end if;
  if p_status not in ('reviewing','resolved','dismissed','pending') then raise exception 'invalid_status'; end if;
  update content_reports
     set status = p_status,
         resolution = coalesce(p_resolution, resolution),
         resolved_at = case when p_status in ('resolved','dismissed') then now() else null end,
         resolved_by = case when p_status in ('resolved','dismissed') then auth.uid() else null end
   where id = p_id;
end $$;
grant execute on function public.admin_resolve_report(bigint, text, text) to authenticated;

-- ── Content moderation actions ───────────────────────────────────────
create or replace function public.admin_delete_comment(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from admins where user_id = auth.uid()) then raise exception 'not_admin'; end if;
  delete from list_item_comments where id = p_id;
end $$;
grant execute on function public.admin_delete_comment(uuid) to authenticated;

create or replace function public.admin_delete_list(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from admins where user_id = auth.uid()) then raise exception 'not_admin'; end if;
  delete from lists where id = p_id;
end $$;
grant execute on function public.admin_delete_list(uuid) to authenticated;

create or replace function public.admin_delete_group(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from admins where user_id = auth.uid()) then raise exception 'not_admin'; end if;
  delete from groups where id = p_id;
end $$;
grant execute on function public.admin_delete_group(uuid) to authenticated;

create or replace function public.admin_delete_list_item(p_owner uuid, p_category text, p_item_name text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from admins where user_id = auth.uid()) then raise exception 'not_admin'; end if;
  update lists
     set items = (
       select coalesce(jsonb_agg(el), '[]'::jsonb)
       from jsonb_array_elements(items) el
       where el::text <> to_jsonb(p_item_name)::text
     ), updated_at = now()
   where user_id = p_owner and category = p_category;
end $$;
grant execute on function public.admin_delete_list_item(uuid, text, text) to authenticated;

-- ── Ban / unban ──────────────────────────────────────────────────────
-- banned_until MUST be finite; see note in the companion migration.
create or replace function public.admin_ban_user(p_uid uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from admins where user_id = auth.uid()) then raise exception 'not_admin'; end if;
  if exists (select 1 from admins where user_id = p_uid) then raise exception 'cannot_ban_an_admin'; end if;
  update profiles
     set is_banned = true, banned_at = now(), banned_reason = coalesce(p_reason, banned_reason)
   where id = p_uid;
  update auth.users set banned_until = '2999-12-31 23:59:59+00'::timestamptz where id = p_uid;
  delete from auth.refresh_tokens where user_id = p_uid::text;
end $$;
grant execute on function public.admin_ban_user(uuid, text) to authenticated;

create or replace function public.admin_unban_user(p_uid uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from admins where user_id = auth.uid()) then raise exception 'not_admin'; end if;
  update profiles set is_banned = false, banned_at = null, banned_reason = null where id = p_uid;
  update auth.users set banned_until = null where id = p_uid;
end $$;
grant execute on function public.admin_unban_user(uuid) to authenticated;

-- ── Invitees + leaderboard (now surfaces marketing channels) ─────────
create or replace function public.get_my_invitees()
returns table (id uuid, display_name text, handle text, photo text, created_at timestamptz)
language sql security definer set search_path = public stable
as $$
  select p.id, p.display_name, p.handle, p.photo, p.created_at
  from profiles p where p.invited_by = auth.uid()
  order by p.created_at desc limit 50;
$$;
grant execute on function public.get_my_invitees() to authenticated;

drop function if exists public.admin_invite_leaderboard(integer);
create function public.admin_invite_leaderboard(p_limit integer default 20)
returns table(
  user_id uuid, display_name text, handle text, email text,
  direct_count bigint, indirect_count bigint, total_count bigint, is_system boolean
)
language plpgsql security definer set search_path to 'public'
as $$
begin
  if not exists (select 1 from public.admins a where a.user_id = auth.uid()) then
    raise exception 'Not authorized';
  end if;
  return query
    with recursive tree as (
      select p.id as invitee_id, p.invited_by as root_id, 1 as depth
        from public.profiles p where p.invited_by is not null
      union all
      select t.invitee_id, p.invited_by as root_id, t.depth + 1
        from tree t join public.profiles p on p.id = t.root_id
       where p.invited_by is not null
    ),
    counts as (
      select root_id as uid,
             sum(case when depth = 1 then 1 else 0 end)::bigint as direct,
             sum(case when depth > 1 then 1 else 0 end)::bigint as indirect
        from tree group by root_id
    )
    select c.uid, pr.display_name, pr.handle, pr.email,
           c.direct, c.indirect, (c.direct + c.indirect)::bigint,
           coalesce(pr.is_system, false)
      from counts c join public.profiles pr on pr.id = c.uid
     order by (c.direct + c.indirect) desc, c.direct desc
     limit p_limit;
end $$;
grant execute on function public.admin_invite_leaderboard(integer) to authenticated;

-- ── Working accounts (test / QA / platform) ──────────────────────────
-- Added 2026-09-09. is_internal marks a real, loginable account that should
-- be excluded from real-user metrics. Distinct from is_system (marketing
-- channel accounts, which cannot log in at all).
alter table public.profiles add column if not exists is_internal boolean not null default false;
create index if not exists idx_profiles_is_internal on public.profiles(is_internal) where is_internal;

create or replace function public.admin_set_internal(p_uid uuid, p_internal boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from admins where user_id = auth.uid()) then raise exception 'not_admin'; end if;
  update profiles set is_internal = coalesce(p_internal, false) where id = p_uid;
end $$;
grant execute on function public.admin_set_internal(uuid, boolean) to authenticated;

create or replace function public.admin_user_counts()
returns table (real_users bigint, internal_users bigint, channel_users bigint, banned_users bigint, total bigint)
language sql security definer set search_path = public stable as $$
  select
    count(*) filter (where not coalesce(is_internal,false) and not coalesce(is_system,false))::bigint,
    count(*) filter (where coalesce(is_internal,false))::bigint,
    count(*) filter (where coalesce(is_system,false))::bigint,
    count(*) filter (where coalesce(is_banned,false))::bigint,
    count(*)::bigint
  from profiles
  where exists (select 1 from admins where user_id = auth.uid());
$$;
grant execute on function public.admin_user_counts() to authenticated;

-- guard_moderation_columns() also covers is_internal (see companion migration).

-- ── LinkedIn marketing channel account (added 2026-09-09) ────────────
-- banned_until MUST be finite; GoTrue cannot scan Postgres 'infinity'.
do $$
declare v_id uuid := '00000000-0000-4000-8000-000000000002';
begin
  if not exists (select 1 from auth.users where id = v_id) then
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      created_at, updated_at, raw_app_meta_data, raw_user_meta_data, banned_until
    ) values (
      '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated',
      'linkedin@channels.mytenner.com',
      '$2a$10$SYSTEMACCOUNTNOLOGINPOSSIBLEXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      now(), now(), now(),
      '{"provider":"system","providers":["system"]}'::jsonb,
      '{"system_channel":"linkedin"}'::jsonb,
      '2999-12-31 23:59:59+00'::timestamptz
    );
  end if;
  insert into public.profiles (id, display_name, handle, email, is_system, created_at)
  values (v_id, 'Tenner on LinkedIn', 'linkedin', 'linkedin@channels.mytenner.com', true, now())
  on conflict (id) do update
    set display_name = excluded.display_name, handle = excluded.handle, is_system = true;
end $$;

-- ── Fix: auto-friend on invite (added 2026-09-12) ────────────────────
-- Auto-friend could never work from the client. friendships_insert requires
-- requester_id = auth.uid(), but the flow runs in the NEW USER's session while
-- setting requester_id to the INVITER, so RLS rejected every insert — silently,
-- because supabase-js returns errors in the result object rather than throwing.
create or replace function public.accept_invite_friendship(p_inviter uuid)
returns text language plpgsql security definer set search_path = public as $$
declare v_me uuid := auth.uid(); v_existing record;
begin
  if v_me is null      then return 'not_authenticated'; end if;
  if p_inviter is null then return 'no_inviter';        end if;
  if p_inviter = v_me  then return 'self';              end if;
  if not exists (
    select 1 from profiles where id = p_inviter
       and coalesce(is_system,false) = false and coalesce(is_banned,false) = false
  ) then return 'inviter_ineligible'; end if;
  if coalesce((select is_banned from profiles where id = v_me), false) then return 'caller_banned'; end if;

  select id, status into v_existing from friendships
   where (requester_id = p_inviter and addressee_id = v_me)
      or (requester_id = v_me and addressee_id = p_inviter) limit 1;

  if v_existing.id is null then
    insert into friendships (requester_id, addressee_id, status)
    values (p_inviter, v_me, 'accepted');
    return 'created';
  elsif v_existing.status = 'pending' then
    update friendships set status = 'accepted' where id = v_existing.id;
    return 'upgraded';
  end if;
  return 'already_friends';
end $$;
grant execute on function public.accept_invite_friendship(uuid) to authenticated;
