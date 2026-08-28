-- Per-viewer "last time I looked at this friend" tracking.
-- Used to turn the orange dot on Circle stories into a real unread indicator:
-- dot shows only when the friend has a public list updated AFTER my last view.

CREATE TABLE IF NOT EXISTS public.friend_views (
  viewer_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  friend_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (viewer_id, friend_id)
);
CREATE INDEX IF NOT EXISTS friend_views_viewer_idx ON public.friend_views(viewer_id);

ALTER TABLE public.friend_views ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage their own friend_views" ON public.friend_views;
CREATE POLICY "Users manage their own friend_views"
  ON public.friend_views
  FOR ALL
  USING (auth.uid() = viewer_id)
  WITH CHECK (auth.uid() = viewer_id);

DROP POLICY IF EXISTS "Admins can view all friend_views" ON public.friend_views;
CREATE POLICY "Admins can view all friend_views"
  ON public.friend_views FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()));

NOTIFY pgrst, 'reload schema';
