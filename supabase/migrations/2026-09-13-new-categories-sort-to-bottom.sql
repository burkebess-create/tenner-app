-- 2026-09-13 — New categories go to the bottom of the ordering
--
-- THE BUG
-- categories.sort_order defaulted to 0, and the admin "+ New category" save
-- never sets it. Movies sits at 1, so every newly created category landed at 0
-- — ahead of everything, taking the first Create-screen slot and pushing
-- whatever the admin had deliberately placed there down a position.
--
-- THE FIX
-- A BEFORE INSERT trigger assigns max(sort_order) + 1 when none is given.
-- Done in the database rather than in saveAdminCat() so it holds for every
-- insert path — the admin button, the weekly-list promotion flow
-- (which computes its own nextSort and is unaffected), seed migrations, and
-- anything inserted by hand.
--
-- The default is dropped rather than changed to a large number, because the
-- trigger needs to distinguish "caller didn't specify" (assign next) from
-- "caller asked for position N" (respect it). With a non-null default those
-- two cases are indistinguishable by the time the trigger runs — which is
-- precisely the shape of the original bug.
--
-- Verified: insert with no sort_order -> max+1; a second insert -> max+2 (no
-- tie); an explicit sort_order is honoured unchanged.

alter table public.categories alter column sort_order drop default;

create or replace function public.categories_default_sort_order()
returns trigger language plpgsql set search_path = public
as $$
begin
  if new.sort_order is null then
    select coalesce(max(sort_order), 0) + 1 into new.sort_order from public.categories;
  end if;
  return new;
end $$;

drop trigger if exists trg_categories_default_sort_order on public.categories;
create trigger trg_categories_default_sort_order
  before insert on public.categories
  for each row execute function public.categories_default_sort_order();
