-- 2026-09-12 — Per-item comment counts for a friend's list
--
-- Why this needs an RPC rather than a query:
--
-- list_item_comments SELECT is restricted to the list owner, the comment's
-- author, and anyone already in that thread (_is_thread_participant). So a
-- friend viewing someone's list can only see comments in threads they have
-- already replied to — a direct count(*) would silently undercount, showing
-- "0 comments" on a busy item.
--
-- This function is SECURITY DEFINER so it can count across that boundary, but
-- it returns COUNTS AND TIMESTAMPS ONLY — never comment text, never author
-- identities. Who can read what anyone actually wrote is unchanged.
--
-- Access: the list owner, or a user with an accepted friendship with them.
-- Verified under `set local role authenticated`: owner 6 rows, accepted friend
-- 6 rows, unrelated user 0 rows.
--
-- `mine` lets the UI mark threads the viewer has commented in. `last_at`
-- compared against comment_thread_reads.last_read_at gives the unread state.

create or replace function public.list_comment_counts(p_owner uuid, p_category text)
returns table (item_name text, total bigint, mine bigint, last_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select c.item_name,
         count(*)                                           as total,
         count(*) filter (where c.from_user_id = auth.uid()) as mine,
         max(c.created_at)                                   as last_at
  from public.list_item_comments c
  where c.list_owner_id = p_owner
    and c.category = p_category
    and (
      p_owner = auth.uid()
      or exists (
        select 1 from public.friendships f
        where f.status = 'accepted'
          and ((f.requester_id = auth.uid() and f.addressee_id = p_owner)
            or (f.addressee_id = auth.uid() and f.requester_id = p_owner))
      )
    )
  group by c.item_name;
$$;

revoke all on function public.list_comment_counts(uuid, text) from public, anon;
grant execute on function public.list_comment_counts(uuid, text) to authenticated;
