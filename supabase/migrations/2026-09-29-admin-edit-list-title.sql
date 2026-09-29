-- Let an admin fix a list's title and emoji from the Lists tab (2026-09-29)
--
-- Applied as: admin_update_list_meta (see below for the body as applied)
--
-- Why an RPC and not a widened policy: lists_update is
--   USING (user_id = auth.uid())
-- so an admin PATCH of someone else's list matches zero rows and returns NO
-- ERROR. supabase-js reports that as success, so the admin screen would have
-- said "List updated." over a row that never changed.
--
-- Why `category` is NOT editable here: a category is identified by its text
-- with no foreign key, and eight other tables store a copy —
-- comment_thread_reads, group_lists, list_change_events, list_item_comments,
-- list_reactions, list_share_invites, match_reveals, shop_clicks — plus
-- profiles.gift_visible_categories as a jsonb array. Changing it in one
-- place detaches the list from its own comments, reactions, shares, group
-- entries and match history. rename_category_everywhere() already exists for
-- that job, complete with a coverage guard that refuses to run a partial
-- rename, and it is reached from the Custom categories tab.
--
-- Verified as applied, in a transaction aborted by RAISE so it rolled back:
--   non-admin (the list's own owner)  refused -> Not authorized
--   admin, on someone else's list     name and emoji updated, category unchanged
--   blank title                       refused -> A list needs a title
--   emoji omitted                     existing emoji kept

create or replace function public.admin_update_list_meta(
  p_list_id uuid,
  p_name    text,
  p_emoji   text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_before record;
  v_name   text := nullif(btrim(coalesce(p_name, '')), '');
  v_emoji  text := nullif(btrim(coalesce(p_emoji, '')), '');
begin
  if not exists (select 1 from admins a where a.user_id = auth.uid()) then
    raise exception 'Not authorized';
  end if;
  if p_list_id is null then
    raise exception 'A list is required';
  end if;
  if v_name is null then
    raise exception 'A list needs a title';
  end if;
  if length(v_name) > 80 then
    raise exception 'That title is too long (80 characters maximum)';
  end if;
  -- One emoji, not a sentence. The column is free text and this value is
  -- rendered next to the title everywhere the list appears.
  if v_emoji is not null and length(v_emoji) > 8 then
    raise exception 'The emoji should be a single character';
  end if;

  select id, name, emoji, category, user_id into v_before from lists where id = p_list_id;
  if v_before.id is null then
    raise exception 'That list no longer exists';
  end if;

  update lists
     set name  = v_name,
         emoji = coalesce(v_emoji, emoji)
   where id = p_list_id;

  return jsonb_build_object(
    'id',            p_list_id,
    'name',          v_name,
    'emoji',         coalesce(v_emoji, v_before.emoji),
    'category',      v_before.category,
    'previous_name', v_before.name,
    -- Surfaced so the admin screen can say plainly that the title no longer
    -- matches the category it is stored under.
    'differs_from_category', (v_name is distinct from ('Top 10 ' || v_before.category))
  );
end $$;

revoke all on function public.admin_update_list_meta(uuid, text, text) from public, anon;
grant execute on function public.admin_update_list_meta(uuid, text, text) to authenticated;
