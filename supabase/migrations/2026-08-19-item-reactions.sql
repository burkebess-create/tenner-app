-- Item-level reactions
-- Extends list_reactions so a reaction can target either the whole list
-- (item_name = '') OR a specific item on that list.
--
-- Existing rows keep item_name = '' after the ALTER, so all whole-list
-- reactions continue to work.

ALTER TABLE public.list_reactions
  ADD COLUMN IF NOT EXISTS item_name text NOT NULL DEFAULT '';

-- Rebuild the unique constraint to include item_name so a user can leave the
-- same emoji on a list AND on individual items without duplicate-key errors.
ALTER TABLE public.list_reactions
  DROP CONSTRAINT IF EXISTS list_reactions_from_user_id_list_owner_id_category_emoji_key;

ALTER TABLE public.list_reactions
  DROP CONSTRAINT IF EXISTS list_reactions_from_user_id_list_owner_id_category_item_name_emoji_key;

ALTER TABLE public.list_reactions
  ADD CONSTRAINT list_reactions_from_user_id_list_owner_id_category_item_name_emoji_key
  UNIQUE (from_user_id, list_owner_id, category, item_name, emoji);

CREATE INDEX IF NOT EXISTS idx_list_reactions_thread
  ON public.list_reactions (list_owner_id, category, item_name);

NOTIFY pgrst, 'reload schema';
