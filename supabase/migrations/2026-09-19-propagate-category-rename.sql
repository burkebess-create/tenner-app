-- 2026-09-19 — Renaming a category now follows through to everyone's lists
--
-- Categories are referenced by NAME in eleven places, not by id. Renaming one
-- in the admin UI updated categories.name and nothing else, so every existing
-- list kept the old name: it stopped matching the category, dropped out of
-- match comparisons against people who filled it in afterwards, lost its
-- autofill pool, and still displayed the old title. Renaming "Favorite bands"
-- to "Bands" orphaned five lists exactly this way.
--
-- Two deliberate limits on what gets rewritten:
--
--   lists.name  is only rebuilt where it still matches the default
--               'Top 10 <old name>'. Anything else was set deliberately and
--               is left alone.
--   lists.emoji is only updated where it still equals the category's OLD
--               emoji. Users can pick their own emoji for a list from the
--               list-detail screen, and overwriting that would quietly
--               discard a choice they made.
--
-- Collisions refuse rather than corrupt: if any user would end up holding two
-- lists under the new name, the rename raises instead of tripping the
-- (user_id, category) unique constraint halfway through and leaving the
-- tables half-migrated.
--
-- shop_clicks is included so affiliate reporting does not split a single
-- category across two names. feedback.category is NOT included — it holds
-- idea/bug/other, not a category name.
--
-- Verified end to end on live data (and reverted): renaming a category moved
-- all 7 of its lists, rebuilt their titles, updated the 6 lists still on the
-- default emoji, left a personalised emoji untouched, carried the related
-- tables across, and refused a rename that would have collided with the
-- message naming how many users were affected.

create or replace function public.rename_category_everywhere(
  p_old_name text, p_new_name text,
  p_old_emoji text default null, p_new_emoji text default null
) returns void
language plpgsql
security definer          -- an admin has no RLS rights over other users' lists
set search_path = public
as $$
declare
  v_collisions int;
begin
  if p_new_name is null or btrim(p_new_name) = '' then
    raise exception 'rename_category_everywhere: new name must not be blank';
  end if;

  if p_old_name is distinct from p_new_name then
    select count(*) into v_collisions
    from lists a
    where a.category = p_old_name
      and exists (select 1 from lists b
                  where b.user_id = a.user_id and b.category = p_new_name);
    if v_collisions > 0 then
      raise exception
        'Cannot rename "%" to "%": % user(s) already have a list under the new name. Merge or delete those first.',
        p_old_name, p_new_name, v_collisions;
    end if;

    update lists
       set category = p_new_name,
           name = case when name = 'Top 10 ' || p_old_name
                       then 'Top 10 ' || p_new_name
                       else name end
     where category = p_old_name;

    update comment_thread_reads set category = p_new_name where category = p_old_name;
    update group_lists           set category = p_new_name where category = p_old_name;
    update list_change_events    set category = p_new_name where category = p_old_name;
    update list_item_comments    set category = p_new_name where category = p_old_name;
    update list_reactions        set category = p_new_name where category = p_old_name;
    update list_share_invites    set category = p_new_name where category = p_old_name;
    update match_reveals         set category = p_new_name where category = p_old_name;
    update weekly_lists          set category = p_new_name where category = p_old_name;
    update shop_clicks           set category = p_new_name where category = p_old_name;

    -- Gift visibility is a jsonb array of category names. Left alone, a rename
    -- silently switches the category off on everyone's gift guide.
    update profiles
       set gift_visible_categories = (
         select jsonb_agg(case when elem = to_jsonb(p_old_name)
                               then to_jsonb(p_new_name) else elem end)
         from jsonb_array_elements(gift_visible_categories) elem)
     where jsonb_typeof(gift_visible_categories) = 'array'
       and jsonb_exists(gift_visible_categories, p_old_name);
  end if;

  -- Only lists still carrying the old default emoji; a personalised one stays.
  if p_new_emoji is not null and p_old_emoji is distinct from p_new_emoji then
    update lists
       set emoji = p_new_emoji
     where category = p_new_name
       and (emoji is null or emoji = p_old_emoji);
  end if;
end $$;

revoke all on function public.rename_category_everywhere(text, text, text, text) from public, anon, authenticated;

create or replace function public.categories_rename_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.name is distinct from old.name or new.emoji is distinct from old.emoji then
    perform public.rename_category_everywhere(old.name, new.name, old.emoji, new.emoji);
  end if;
  return new;
end $$;

drop trigger if exists trg_categories_rename on public.categories;
create trigger trg_categories_rename
  after update of name, emoji on public.categories
  for each row execute function public.categories_rename_trigger();

-- One-off: the "Favorite bands" -> "Bands" rename had already happened in the
-- admin UI before this trigger existed, leaving 5 lists, 2 comment_thread_reads
-- and 1 list_change_event behind.
--   select public.rename_category_everywhere('Favorite bands', 'Bands', null, '🎸');
