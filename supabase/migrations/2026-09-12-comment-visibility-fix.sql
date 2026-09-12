-- 2026-09-12 — Make "Which comments do I see on friends' lists?" actually work
--
-- THE BUG
-- The profile setting (all / only people I know / none) promises the viewer
-- they can see what others have said on a friend's list items. The SELECT
-- policy on list_item_comments did not allow it: reads were limited to the
-- list owner, the comment's author, and people already in that thread. So
-- "All comments" could never surface anything the viewer hadn't written or
-- replied to — the setting was effectively dead, and comment-count badges
-- read 0 on any thread the viewer hadn't joined.
--
-- THE RULE
-- You can read comments on a list exactly when you can read the list itself.
-- An earlier pass here used "accepted friend of the owner", which fixed the
-- reported case but left the same hole for the other doors into a list:
-- lists_select also admits accepted co-members of a group carrying that
-- category, and both sides of a list-share invite. Deferring to the lists
-- policy keeps the two from drifting.
--
-- _can_view_list is SECURITY INVOKER on purpose — the lookup must run as the
-- caller so lists' own RLS decides.
--
-- Narrowing further ("only people I know") is the VIEWER'S own preference and
-- stays a client-side filter: relaxing it only ever shows the viewer more of
-- what this policy already permits. Whether anyone may comment at all remains
-- the owner's separate control (profiles.allow_comments_on_my_lists) enforced
-- on INSERT, which this migration does not touch.
--
-- Verified under `set local role authenticated`:
--   owner        11 of 11 comments
--   friend       11 of 11 comments (was the bug), list visible
--   non-friend    0 of 11 comments, list not visible

create or replace function public._can_view_list(p_owner uuid, p_category text)
returns boolean
language sql
stable
security invoker          -- deliberate: lists RLS must apply to this lookup
set search_path = public
as $$
  select exists (
    select 1 from public.lists l
    where l.user_id = p_owner and l.category = p_category
  );
$$;
grant execute on function public._can_view_list(uuid, text) to authenticated;

drop policy if exists list_item_comments_select on public.list_item_comments;
create policy list_item_comments_select on public.list_item_comments
  for select to authenticated
  using (
    (select auth.uid()) = list_owner_id
    or (select auth.uid()) = from_user_id
    or public._is_thread_participant(list_owner_id, category, item_name)
    or public._can_view_list(list_owner_id, category)
    or exists (select 1 from public.admins where admins.user_id = (select auth.uid()))
  );

-- Interim helper from the first pass, superseded by _can_view_list.
drop function if exists public._is_accepted_friend(uuid);

-- ─────────────────────────────────────────────────────────────────────
-- list_comment_counts: drop SECURITY DEFINER
--
-- DANGER, for anyone tempted to reinstate it: this function was briefly
-- SECURITY DEFINER with `_can_view_list(...)` in its WHERE clause. Inside a
-- DEFINER function the inner SECURITY INVOKER lookup runs as the function
-- OWNER, which bypasses RLS — so _can_view_list returned true for everyone and
-- the counts leaked to unrelated users. A non-friend got 6 rows where 0 were
-- required.
--
-- DEFINER was only ever needed because the old policy hid comments from people
-- who could see the list. Now that the policy admits them, invoker rights are
-- both correct and safe: RLS filters the rows, so counts can never exceed what
-- the caller may read, and there is no hand-written access check to drift.
--
-- Verified: non-friend 0 rows, friend 6 items/11 comments, owner 6 items/11
-- comments/2 mine.
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.list_comment_counts(p_owner uuid, p_category text)
returns table (item_name text, total bigint, mine bigint, last_at timestamptz)
language sql
stable
security invoker
set search_path = public
as $$
  select c.item_name,
         count(*)                                            as total,
         count(*) filter (where c.from_user_id = auth.uid()) as mine,
         max(c.created_at)                                   as last_at
  from public.list_item_comments c
  where c.list_owner_id = p_owner
    and c.category = p_category
  group by c.item_name;
$$;

revoke all on function public.list_comment_counts(uuid, text) from public, anon;
grant execute on function public.list_comment_counts(uuid, text) to authenticated;
