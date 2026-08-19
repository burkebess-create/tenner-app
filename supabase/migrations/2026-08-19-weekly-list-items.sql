-- Item suggestions for weekly lists
-- Mirrors category_items: admin can preload suggested items for a specific
-- weekly-list prompt so users see typeahead suggestions when filling it out.

CREATE TABLE IF NOT EXISTS public.weekly_list_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  weekly_list_id uuid NOT NULL REFERENCES public.weekly_lists(id) ON DELETE CASCADE,
  item_text text NOT NULL,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_weekly_list_items_wl
  ON public.weekly_list_items (weekly_list_id, sort_order);

ALTER TABLE public.weekly_list_items ENABLE ROW LEVEL SECURITY;

-- Everyone can read (they're public suggestions, same as category_items)
DROP POLICY IF EXISTS "Anyone can read weekly_list_items" ON public.weekly_list_items;
CREATE POLICY "Anyone can read weekly_list_items"
  ON public.weekly_list_items FOR SELECT
  USING (true);

-- Only admins can insert/update/delete
DROP POLICY IF EXISTS "Admins manage weekly_list_items" ON public.weekly_list_items;
CREATE POLICY "Admins manage weekly_list_items"
  ON public.weekly_list_items FOR ALL
  USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()));

NOTIFY pgrst, 'reload schema';
