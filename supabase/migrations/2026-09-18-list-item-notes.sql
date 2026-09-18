-- 2026-09-18 — Per-item notes ("why I love this") for gift guides
--
-- WHY
-- A gift page that is a bare list of names plus Amazon search buttons is
-- thin affiliate content: nothing on it is original, and nothing tells the
-- reader why a pick is a good gift or who it suits. The durable fix is
-- first-party writing from the person whose guide it is — their own sentence
-- about a pick is original, specific, and impossible to generate.
--
-- SHAPE
-- jsonb object keyed by the item's text: {"Interstellar": "why I love it"}.
-- Keyed by text rather than index because items get reordered constantly
-- (drag-to-rank is the core interaction) and an index-keyed map would
-- silently reattach notes to the wrong picks on every reorder. The tradeoff
-- is that renaming an item orphans its note, which is the safer failure:
-- a missing note degrades to the factual fallback, a mis-attached one would
-- put words in someone's mouth. Verified with unit tests over reorder,
-- delete, rename and blank.
--
-- Notes inherit the visibility of the list they live on. get_public_gift_data
-- already gates on gift_visible_categories, so a note is exposed exactly
-- where its list is and nowhere else. Length and moderation are enforced
-- client-side on write, mirroring list_item_comments (280 chars +
-- moderate-text), and re-clamped on render so a note written before those
-- limits can never blow out the page.
--
-- Verified end-to-end in a rolled-back transaction: a note written to
-- lists.item_notes comes back through get_public_gift_data keyed by item text.

alter table public.lists
  add column if not exists item_notes jsonb not null default '{}'::jsonb;

create or replace function public.get_public_gift_data(share_token text)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
DECLARE
  p_row profiles%ROWTYPE;
  vis_json jsonb;
  lists_json jsonb;
BEGIN
  SELECT * INTO p_row FROM profiles WHERE gift_share_token = share_token LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;

  vis_json := to_jsonb(p_row.gift_visible_categories);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'category',   l.category,
    'emoji',      l.emoji,
    'items',      l.items,
    'is_ranked',  l.is_ranked,
    'item_notes', COALESCE(l.item_notes, '{}'::jsonb)
  ) ORDER BY l.updated_at DESC), '[]'::jsonb)
  INTO lists_json
  FROM lists l
  WHERE l.user_id = p_row.id
    AND (
      vis_json IS NULL
      OR vis_json = 'null'::jsonb
      OR jsonb_typeof(vis_json) <> 'array'
      OR jsonb_array_length(vis_json) = 0
      OR vis_json ? l.category
    );

  RETURN jsonb_build_object(
    'display_name', p_row.display_name,
    'handle',       p_row.handle,
    'photo',        p_row.photo,
    'birthday',     p_row.birthday,
    'lists',        COALESCE(lists_json, '[]'::jsonb)
  );
END;
$function$;
