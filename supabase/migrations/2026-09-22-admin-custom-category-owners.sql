-- Who actually has a given custom category (2026-09-22)
--
-- Applied as: admin_custom_category_owners
--
-- The Custom tab told you "4 people · 381 picks" and stopped there. Finding
-- out WHICH four meant leaving for the Lists tab and retyping the category,
-- where the match is a substring over the 300 most recently updated lists.
-- Two problems with that as the answer:
--   * "marvel" merges "Marvel movies" with "Marvel Superheroes" — the exact
--     pair you would most want to tell apart before promoting one.
--   * the 300-row cap fails SILENTLY, returning fewer people than really have
--     the list. 183 lists exist today, so it does not bite yet.
--
-- This matches the category exactly and has no cap, so the names always add
-- up to the number on the tile. Verified for three categories that the count
-- here equals admin_custom_categories(): 4/4, 3/3, 2/2.
--
-- Email is returned here rather than through a second admin_profile_contacts
-- round trip. Several accounts still have no display_name and no handle, and
-- without the email they render as "unknown" on a screen whose whole purpose
-- is saying who someone is. SECURITY DEFINER reaches past the RLS that hides
-- profiles.email, so the admin check is the gate — and it is the first thing
-- the WHERE clause evaluates.
--
-- VERIFIED: a non-admin authenticated user gets 0 rows; anon is blocked at
-- EXECUTE.

create or replace function public.admin_custom_category_owners(p_category text)
returns table (
  user_id uuid,
  display_name text,
  handle text,
  email text,
  list_id uuid,
  item_count int,
  is_public boolean,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path to 'public'
as $$
  select p.id, p.display_name, p.handle, p.email,
         l.id, jsonb_array_length(l.items)::int, l.is_public, l.updated_at
  from public.lists l
  join public.profiles p on p.id = l.user_id
  where exists (select 1 from public.admins a where a.user_id = auth.uid())
    and l.category = p_category
  order by l.updated_at desc;
$$;

revoke all on function public.admin_custom_category_owners(text) from public, anon;
grant execute on function public.admin_custom_category_owners(text) to authenticated;
