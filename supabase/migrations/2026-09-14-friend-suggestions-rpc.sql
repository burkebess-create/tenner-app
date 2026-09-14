-- 2026-09-14 — "People you may know" was broken for every non-admin
--
-- THE BUG
-- The client built suggestions by reading friendships rows for each of the
-- viewer's friends. friendships_select only exposes rows where YOU are the
-- requester or addressee (or you are an admin). So a normal user could never
-- read their friends' OTHER friendships: the only rows they got back were
-- their own, whose other side the client then excluded as "already
-- connected". The list was permanently empty.
--
-- It looked like it worked because the policy exempts admins, and the only
-- person testing it was one. Measured on live data: a non-admin with 4
-- accepted friends could read 4 friendship rows; the same query as an admin
-- returned 55.
--
-- THE FIX
-- A SECURITY DEFINER function returning the SUGGESTIONS instead of the raw
-- graph. friendships_select is deliberately NOT widened — no caller gains the
-- ability to read arbitrary friendship rows. The function returns only what
-- the card already shows: a candidate, and which of the VIEWER'S OWN friends
-- know them, so every name revealed is someone the viewer already knows.
--
-- Scope limits, all deliberate:
--   * accepted friendships only, on BOTH hops — pending requests are never
--     traversed, so a stranger who sends you a request cannot have their
--     graph exposed (and cannot see yours).
--   * excludes anyone the viewer has ANY friendship with, in any state.
--   * excludes dismissals (the X on a suggestion card), which the client
--     previously applied itself.
--   * excludes is_system (marketing channel) and is_banned accounts — neither
--     was filtered client-side at all.
--
-- Verified under `set local role authenticated` as a non-admin with friends:
--   17 suggestions returned (0 before); never self; never an existing
--   connection in any state; never a channel account; and every returned
--   mutual id is one of the viewer's own accepted friends.

create or replace function public.get_friend_suggestions(p_limit integer default 20)
returns table (candidate_id uuid, mutual_count bigint, mutual_ids uuid[])
language sql
stable
security definer
set search_path = public
as $$
  with me as (select auth.uid() as uid),
  my_friends as (
    select case when f.requester_id = (select uid from me) then f.addressee_id else f.requester_id end as fid
    from public.friendships f, me
    where f.status = 'accepted'
      and me.uid in (f.requester_id, f.addressee_id)
  ),
  related as (
    select (select uid from me) as id
    union
    select case when f.requester_id = (select uid from me) then f.addressee_id else f.requester_id end
    from public.friendships f, me
    where me.uid in (f.requester_id, f.addressee_id)
    union
    select d.dismissed_id from public.friend_suggestion_dismissals d, me
    where d.user_id = me.uid
  ),
  hops as (
    select mf.fid as via,
           case when f.requester_id = mf.fid then f.addressee_id else f.requester_id end as candidate
    from my_friends mf
    join public.friendships f
      on f.status = 'accepted'
     and mf.fid in (f.requester_id, f.addressee_id)
  )
  select h.candidate as candidate_id,
         count(distinct h.via)::bigint as mutual_count,
         array_agg(distinct h.via) as mutual_ids
  from hops h
  join public.profiles p on p.id = h.candidate
  where h.candidate not in (select id from related)
    and coalesce(p.is_system, false) = false
    and coalesce(p.is_banned, false) = false
  group by h.candidate
  order by count(distinct h.via) desc, h.candidate
  limit greatest(coalesce(p_limit, 20), 1);
$$;

revoke all on function public.get_friend_suggestions(integer) from public, anon;
grant execute on function public.get_friend_suggestions(integer) to authenticated;
