-- Blocking, part 1: the table and the policy helper (2026-09-29)
--
-- App Store guideline 1.2 requires a UGC app to let users block abusive
-- accounts. Tenner had reporting, moderation and admin banning, but the
-- closest thing a user had was unfriend() — and someone you unfriend can
-- re-add you the same minute and still read anything you share.
--
-- Blocks HIDE rather than delete, and are reversible, which is the
-- convention on every major platform and is what reviewers expect. Nothing
-- in 1.2 asks for content to be destroyed, and deleting would be worse: it
-- would wipe the evidence a report is based on.
--
-- The block is symmetric. Whoever pressed the button, neither party sees the
-- other afterwards.
--
-- Applied as: user_blocks_table_and_helper (20260929020930)

create table if not exists public.user_blocks (
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint user_blocks_not_self check (blocker_id <> blocked_id)
);

-- The helper looks up by blocked_id as often as blocker_id, since the check
-- runs symmetrically on every row read.
create index if not exists user_blocks_blocked_idx on public.user_blocks (blocked_id);

alter table public.user_blocks enable row level security;

-- You can see and manage only your own blocks. Deliberately NOT readable by
-- the person you blocked: they must not be able to detect it.
drop policy if exists user_blocks_select_own on public.user_blocks;
create policy user_blocks_select_own on public.user_blocks
  for select to authenticated using (blocker_id = (select auth.uid()));

drop policy if exists user_blocks_insert_own on public.user_blocks;
create policy user_blocks_insert_own on public.user_blocks
  for insert to authenticated with check (blocker_id = (select auth.uid()));

drop policy if exists user_blocks_delete_own on public.user_blocks;
create policy user_blocks_delete_own on public.user_blocks
  for delete to authenticated using (blocker_id = (select auth.uid()));

-- ── the policy helper ─────────────────────────────────────────────────
-- SECURITY DEFINER because it reads rows the caller cannot: the blocked
-- party must never be able to see the block, but the policy still has to
-- evaluate it as them.
--
-- STABLE so the planner can cache it per statement rather than per row.
create or replace function public.is_blocked_pair(a uuid, b uuid)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from public.user_blocks
     where (blocker_id = a and blocked_id = b)
        or (blocker_id = b and blocked_id = a)
  );
$$;

-- RULE, relearned the hard way on this project: a function named in an RLS
-- policy must be EXECUTE-able by EVERY role that policy applies to. Policy
-- predicates evaluate as the querying role regardless of how the function is
-- defined. Revoking EXECUTE on are_friends() once emptied the Circle feed for
-- days. The policies below apply to PUBLIC and to authenticated, so this
-- mirrors exactly what are_friends() and _can_view_list() are granted.
grant execute on function public.is_blocked_pair(uuid, uuid) to public, anon, authenticated;


-- Blocking, part 2: enforce it in RLS, not the UI (2026-09-29)
--
-- Tenner reads nearly everything straight from Supabase with the user's own
-- token. A block implemented only in rendering code would be cosmetic — a
-- blocked person could still read the blocker's lists with developer tools.
--
-- Each policy keeps its ADMIN branch outside the block check, so moderation
-- still sees everything. Without that, an admin who gets blocked by a user
-- would lose the ability to review reports about them, which is exactly
-- backwards.
--
-- Shape used throughout:
--     is_admin  OR  ( <original non-admin branches>  AND  NOT is_blocked_pair(other, me) )
--
-- friendships is deliberately left alone: block_user() deletes those rows.
--
-- Applied as: enforce_blocks_in_read_policies (20260929021110)

-- ── lists ─────────────────────────────────────────────────────────────
drop policy if exists lists_select on public.lists;
create policy lists_select on public.lists
for select using (
  (exists (select 1 from admins where admins.user_id = (select auth.uid())))
  or (
    (
      user_id = (select auth.uid())
      or (is_public = true and are_friends(user_id, (select auth.uid())))
      or exists (select 1 from list_share_invites
                  where list_share_invites.from_user_id = lists.user_id
                    and list_share_invites.to_user_id = (select auth.uid())
                    and list_share_invites.category = lists.category)
      or exists (select 1 from list_share_invites
                  where list_share_invites.to_user_id = lists.user_id
                    and list_share_invites.from_user_id = (select auth.uid())
                    and list_share_invites.category = lists.category)
      or exists (select 1 from ((group_lists gl
                   join group_members gm1 on gm1.group_id = gl.group_id)
                   join group_members gm2 on gm2.group_id = gl.group_id)
                  where gl.category = lists.category
                    and gm1.user_id = (select auth.uid()) and gm1.status = 'accepted'
                    and gm2.user_id = lists.user_id and gm2.status = 'accepted')
    )
    and not is_blocked_pair(lists.user_id, (select auth.uid()))
  )
);

-- ── list_item_comments ────────────────────────────────────────────────
-- Blocks hide the comment from the blocker's own thread as well as hiding
-- the blocker's comments from the blocked user. Deleting a comment for
-- everyone stays a separate, deliberate action on your own list.
drop policy if exists list_item_comments_select on public.list_item_comments;
create policy list_item_comments_select on public.list_item_comments
for select to authenticated using (
  (exists (select 1 from admins where admins.user_id = (select auth.uid())))
  or (
    (
      (select auth.uid()) = list_owner_id
      or (select auth.uid()) = from_user_id
      or _is_thread_participant(list_owner_id, category, item_name)
      or _can_view_list(list_owner_id, category)
    )
    and not is_blocked_pair(from_user_id, (select auth.uid()))
    and not is_blocked_pair(list_owner_id, (select auth.uid()))
  )
);

-- ── list_reactions ────────────────────────────────────────────────────
drop policy if exists list_reactions_select on public.list_reactions;
create policy list_reactions_select on public.list_reactions
for select using (
  (exists (select 1 from admins where admins.user_id = (select auth.uid())))
  or (
    ((select auth.uid()) = from_user_id or (select auth.uid()) = list_owner_id)
    and not is_blocked_pair(from_user_id, (select auth.uid()))
    and not is_blocked_pair(list_owner_id, (select auth.uid()))
  )
);

-- ── profiles ──────────────────────────────────────────────────────────
-- Was USING (true) for authenticated. A blocked pair can no longer see each
-- other's profile at all, which is what makes someone disappear from search,
-- suggestions and comment attribution.
--
-- Your own row is always visible: is_blocked_pair(x, x) is false, and the
-- table's CHECK constraint makes blocking yourself impossible anyway.
--
-- The blocker still needs to SEE who they blocked, to unblock them. RLS now
-- hides that row, so the Blocked-accounts list is served by
-- my_blocked_accounts() instead — see part 3.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
for select to authenticated using (
  (exists (select 1 from admins where admins.user_id = (select auth.uid())))
  or not is_blocked_pair(profiles.id, (select auth.uid()))
);


-- Blocking, part 3: the actions (2026-09-29)
--
-- Applied as: block_unblock_rpcs (20260929021129)

-- Blocking severs the connection as well as hiding, which is the convention
-- everywhere. Pending requests in BOTH directions go too, otherwise a stale
-- request sits in a limbo neither party can see or act on.
create or replace function public.block_user(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare uid uuid := auth.uid(); removed int;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if p_user is null or p_user = uid then raise exception 'cannot block yourself'; end if;
  if not exists (select 1 from profiles where id = p_user) then
    raise exception 'no such user';
  end if;

  insert into user_blocks (blocker_id, blocked_id)
  values (uid, p_user)
  on conflict (blocker_id, blocked_id) do nothing;

  -- Drop the friendship and any pending request, either direction.
  with gone as (
    delete from friendships
     where (requester_id = uid and addressee_id = p_user)
        or (requester_id = p_user and addressee_id = uid)
    returning 1
  ) select count(*) into removed from gone;

  -- Stop anything already queued from reaching either of them.
  delete from notification_queue
   where (from_user_id = uid and recipient_user_id = p_user)
      or (from_user_id = p_user and recipient_user_id = uid);

  return jsonb_build_object('blocked', true, 'friendships_removed', removed);
end $$;

-- Unblocking restores VISIBILITY, not the relationship — matching Instagram
-- and Facebook. Silently reinstating a friendship someone deliberately
-- severed would be a nasty surprise, and here it would also hand back read
-- access to their lists. They send a fresh request like anyone else.
create or replace function public.unblock_user(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare uid uuid := auth.uid(); n int;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  with gone as (
    delete from user_blocks where blocker_id = uid and blocked_id = p_user returning 1
  ) select count(*) into n from gone;
  return jsonb_build_object('unblocked', n > 0);
end $$;

-- RLS now hides blocked people's profiles from the blocker too, so the
-- Blocked-accounts screen cannot read them the normal way. This returns just
-- enough to recognise and unblock someone: no email, no phone.
create or replace function public.my_blocked_accounts()
returns table (user_id uuid, display_name text, handle text, photo text, created_at timestamptz)
language sql
stable security definer
set search_path to 'public'
as $$
  select p.id, p.display_name, p.handle, p.photo, b.created_at
    from user_blocks b join profiles p on p.id = b.blocked_id
   where b.blocker_id = auth.uid()
   order by b.created_at desc;
$$;

revoke all on function public.block_user(uuid) from public, anon;
revoke all on function public.unblock_user(uuid) from public, anon;
revoke all on function public.my_blocked_accounts() from public, anon;
grant execute on function public.block_user(uuid) to authenticated;
grant execute on function public.unblock_user(uuid) to authenticated;
grant execute on function public.my_blocked_accounts() to authenticated;
