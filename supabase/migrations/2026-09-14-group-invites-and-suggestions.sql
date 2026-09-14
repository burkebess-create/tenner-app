-- 2026-09-14 — Group co-members in "People you may know"
--
-- A group is often how people first meet on Tenner, but the connection died
-- with the group: someone you shared a book club or work team with was never
-- suggested as a friend.
--
-- Group co-members are now suggested, ranked strictly BELOW friends-of-
-- friends. A shared group is a real signal but a weaker one than several
-- mutual friends, so they sort after every friends-of-friends candidate
-- rather than interleaving by count.
--
-- The return type gains `source` ('mutual' | 'group') and `group_names` so the
-- card can state its reason — "3 mutual · Kara, Ang" or "In Amusement Park
-- Friends with you". A suggestion with no stated reason reads as guesswork.
--
-- Exclusions are unchanged: self, any existing friendship in any state,
-- dismissals, system/channel accounts, banned users. Still SECURITY DEFINER
-- returning only suggestions, never the underlying graph.
--
-- Verified under `set local role authenticated`, including against a
-- synthetic group built and torn down inside the test (no live pair existed
-- where a group co-member was not already a friend): the co-member is
-- suggested with source 'group' and the group named; once they become
-- friends they drop out; mutual candidates always rank above group ones;
-- never self, never an existing connection.

drop function if exists public.get_friend_suggestions(integer);

create function public.get_friend_suggestions(p_limit integer default 20)
returns table (
  candidate_id uuid,
  mutual_count bigint,
  mutual_ids   uuid[],
  source       text,
  group_names  text[]
)
language sql
stable
security definer
set search_path = public
as $$
  with me as (select auth.uid() as uid),
  my_friends as (
    select case when f.requester_id = (select uid from me) then f.addressee_id else f.requester_id end as fid
    from public.friendships f, me
    where f.status = 'accepted' and me.uid in (f.requester_id, f.addressee_id)
  ),
  related as (
    select (select uid from me) as id
    union
    select case when f.requester_id = (select uid from me) then f.addressee_id else f.requester_id end
    from public.friendships f, me
    where me.uid in (f.requester_id, f.addressee_id)
    union
    select d.dismissed_id from public.friend_suggestion_dismissals d, me where d.user_id = me.uid
  ),
  hops as (
    select mf.fid as via,
           case when f.requester_id = mf.fid then f.addressee_id else f.requester_id end as candidate
    from my_friends mf
    join public.friendships f on f.status = 'accepted' and mf.fid in (f.requester_id, f.addressee_id)
  ),
  mutual_cands as (
    select h.candidate as id,
           count(distinct h.via)::bigint as mutuals,
           array_agg(distinct h.via) as via_ids
    from hops h
    where h.candidate not in (select id from related)
    group by h.candidate
  ),
  my_groups as (
    select gm.group_id from public.group_members gm, me
    where gm.user_id = me.uid and gm.status = 'accepted'
  ),
  group_cands as (
    select gm.user_id as id, array_agg(distinct g.name) as gnames
    from public.group_members gm
    join my_groups mg on mg.group_id = gm.group_id
    join public.groups g on g.id = gm.group_id
    where gm.status = 'accepted'
      and gm.user_id not in (select id from related)
      and gm.user_id not in (select id from mutual_cands)
    group by gm.user_id
  ),
  combined as (
    select id, mutuals, via_ids, 'mutual'::text as source, null::text[] as gnames, 0 as rank_group
    from mutual_cands
    union all
    select id, 0::bigint, null::uuid[], 'group'::text, gnames, 1 from group_cands
  )
  select c.id, c.mutuals, c.via_ids, c.source, c.gnames
  from combined c
  join public.profiles p on p.id = c.id
  where coalesce(p.is_system, false) = false
    and coalesce(p.is_banned, false) = false
  order by c.rank_group, c.mutuals desc, c.id
  limit greatest(coalesce(p_limit, 20), 1);
$$;

revoke all on function public.get_friend_suggestions(integer) from public, anon;
grant execute on function public.get_friend_suggestions(integer) to authenticated;
