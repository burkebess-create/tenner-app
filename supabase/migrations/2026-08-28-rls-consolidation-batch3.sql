-- Performance advisor cleanup — batch 3 (RLS consolidation, final pass)
--
-- Splits remaining FOR ALL policies into separate INSERT/UPDATE/DELETE and
-- merges leftover overlapping SELECT policies on: comment_thread_reads,
-- email_log, feedback, list_reactions, match_reveals, friend_views,
-- user_email_prefs, weekly_list_items, weekly_lists, categories,
-- category_items. Applied to remote db 2026-08-28.
--
-- See git commit for the full applied SQL — matches the sequence of
-- "DROP POLICY IF EXISTS … CREATE POLICY …" statements executed via the
-- Supabase SQL editor.

DROP POLICY IF EXISTS "Admins can view all comment_thread_reads" ON public.comment_thread_reads;
DROP POLICY IF EXISTS "Thread participants see reads" ON public.comment_thread_reads;
DROP POLICY IF EXISTS "Users manage own reads" ON public.comment_thread_reads;
CREATE POLICY "comment_thread_reads_select" ON public.comment_thread_reads FOR SELECT
  USING (
    ((select auth.uid()) = user_id)
    OR public._is_thread_participant(list_owner_id, category, item_name)
    OR ((select auth.uid()) = list_owner_id)
    OR EXISTS (SELECT 1 FROM public.admins WHERE user_id = (select auth.uid()))
  );
CREATE POLICY "comment_thread_reads_insert" ON public.comment_thread_reads FOR INSERT
  WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "comment_thread_reads_update" ON public.comment_thread_reads FOR UPDATE
  USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "comment_thread_reads_delete" ON public.comment_thread_reads FOR DELETE
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Admins can view all email_log" ON public.email_log;
DROP POLICY IF EXISTS "email_log admin all" ON public.email_log;
DROP POLICY IF EXISTS "email_log own insert" ON public.email_log;
DROP POLICY IF EXISTS "email_log own read" ON public.email_log;
CREATE POLICY "email_log_select" ON public.email_log FOR SELECT
  USING (
    ((select auth.uid()) = user_id)
    OR EXISTS (SELECT 1 FROM public.admins WHERE user_id = (select auth.uid()))
  );
CREATE POLICY "email_log_insert" ON public.email_log FOR INSERT
  WITH CHECK (
    ((select auth.uid()) = user_id)
    OR EXISTS (SELECT 1 FROM public.admins WHERE user_id = (select auth.uid()))
  );
CREATE POLICY "email_log_admin_update" ON public.email_log FOR UPDATE
  USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = (select auth.uid())))
  WITH CHECK (EXISTS (SELECT 1 FROM public.admins WHERE user_id = (select auth.uid())));
CREATE POLICY "email_log_admin_delete" ON public.email_log FOR DELETE
  USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = (select auth.uid())));

DROP POLICY IF EXISTS "Admins can view all feedback" ON public.feedback;
DROP POLICY IF EXISTS "Admins delete feedback" ON public.feedback;
DROP POLICY IF EXISTS "feedback admin all" ON public.feedback;
DROP POLICY IF EXISTS "feedback insert" ON public.feedback;
DROP POLICY IF EXISTS "feedback own read" ON public.feedback;
CREATE POLICY "feedback_select" ON public.feedback FOR SELECT
  USING (
    ((select auth.uid()) = user_id)
    OR EXISTS (SELECT 1 FROM public.admins WHERE user_id = (select auth.uid()))
  );
CREATE POLICY "feedback_insert" ON public.feedback FOR INSERT
  WITH CHECK (
    ((select auth.uid()) = user_id)
    OR EXISTS (SELECT 1 FROM public.admins WHERE user_id = (select auth.uid()))
  );
CREATE POLICY "feedback_admin_update" ON public.feedback FOR UPDATE
  USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = (select auth.uid())))
  WITH CHECK (EXISTS (SELECT 1 FROM public.admins WHERE user_id = (select auth.uid())));
CREATE POLICY "feedback_delete" ON public.feedback FOR DELETE
  USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = (select auth.uid())));

DROP POLICY IF EXISTS "Admins can view all list_reactions" ON public.list_reactions;
DROP POLICY IF EXISTS "List owners see reactions" ON public.list_reactions;
DROP POLICY IF EXISTS "Users manage own reactions" ON public.list_reactions;
CREATE POLICY "list_reactions_select" ON public.list_reactions FOR SELECT
  USING (
    ((select auth.uid()) = from_user_id)
    OR ((select auth.uid()) = list_owner_id)
    OR EXISTS (SELECT 1 FROM public.admins WHERE user_id = (select auth.uid()))
  );
CREATE POLICY "list_reactions_insert" ON public.list_reactions FOR INSERT
  WITH CHECK ((select auth.uid()) = from_user_id);
CREATE POLICY "list_reactions_update" ON public.list_reactions FOR UPDATE
  USING ((select auth.uid()) = from_user_id) WITH CHECK ((select auth.uid()) = from_user_id);
CREATE POLICY "list_reactions_delete" ON public.list_reactions FOR DELETE
  USING ((select auth.uid()) = from_user_id);

DROP POLICY IF EXISTS "Admins can view all match_reveals" ON public.match_reveals;
DROP POLICY IF EXISTS "own match reveals read" ON public.match_reveals;
DROP POLICY IF EXISTS "own match reveals write" ON public.match_reveals;
CREATE POLICY "match_reveals_select" ON public.match_reveals FOR SELECT
  USING (
    ((select auth.uid()) = user_id)
    OR EXISTS (SELECT 1 FROM public.admins WHERE user_id = (select auth.uid()))
  );
CREATE POLICY "match_reveals_insert" ON public.match_reveals FOR INSERT
  WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "match_reveals_update" ON public.match_reveals FOR UPDATE
  USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "match_reveals_delete" ON public.match_reveals FOR DELETE
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Admins can view all friend_views" ON public.friend_views;
DROP POLICY IF EXISTS "Users manage their own friend_views" ON public.friend_views;
CREATE POLICY "friend_views_select" ON public.friend_views FOR SELECT
  USING (
    ((select auth.uid()) = viewer_id)
    OR EXISTS (SELECT 1 FROM public.admins WHERE user_id = (select auth.uid()))
  );
CREATE POLICY "friend_views_insert" ON public.friend_views FOR INSERT
  WITH CHECK ((select auth.uid()) = viewer_id);
CREATE POLICY "friend_views_update" ON public.friend_views FOR UPDATE
  USING ((select auth.uid()) = viewer_id) WITH CHECK ((select auth.uid()) = viewer_id);
CREATE POLICY "friend_views_delete" ON public.friend_views FOR DELETE
  USING ((select auth.uid()) = viewer_id);

DROP POLICY IF EXISTS "Admins can view all user_email_prefs" ON public.user_email_prefs;
DROP POLICY IF EXISTS "Users manage own email prefs" ON public.user_email_prefs;
CREATE POLICY "user_email_prefs_select" ON public.user_email_prefs FOR SELECT
  USING (
    ((select auth.uid()) = user_id)
    OR EXISTS (SELECT 1 FROM public.admins WHERE user_id = (select auth.uid()))
  );
CREATE POLICY "user_email_prefs_insert" ON public.user_email_prefs FOR INSERT
  WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "user_email_prefs_update" ON public.user_email_prefs FOR UPDATE
  USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "user_email_prefs_delete" ON public.user_email_prefs FOR DELETE
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Admins can view all weekly_list_items" ON public.weekly_list_items;
DROP POLICY IF EXISTS "Admins manage weekly_list_items" ON public.weekly_list_items;
CREATE POLICY "weekly_list_items_admin_insert" ON public.weekly_list_items FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM public.admins WHERE user_id = (select auth.uid())));
CREATE POLICY "weekly_list_items_admin_update" ON public.weekly_list_items FOR UPDATE
  USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = (select auth.uid())))
  WITH CHECK (EXISTS (SELECT 1 FROM public.admins WHERE user_id = (select auth.uid())));
CREATE POLICY "weekly_list_items_admin_delete" ON public.weekly_list_items FOR DELETE
  USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = (select auth.uid())));

DROP POLICY IF EXISTS "Admins can view all weekly_lists" ON public.weekly_lists;
DROP POLICY IF EXISTS "weekly_lists admin write" ON public.weekly_lists;
CREATE POLICY "weekly_lists_admin_insert" ON public.weekly_lists FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM public.admins WHERE user_id = (select auth.uid())));
CREATE POLICY "weekly_lists_admin_update" ON public.weekly_lists FOR UPDATE
  USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = (select auth.uid())))
  WITH CHECK (EXISTS (SELECT 1 FROM public.admins WHERE user_id = (select auth.uid())));
CREATE POLICY "weekly_lists_admin_delete" ON public.weekly_lists FOR DELETE
  USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = (select auth.uid())));

DROP POLICY IF EXISTS "cats admin write" ON public.categories;
CREATE POLICY "cats_admin_insert" ON public.categories FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM public.admins WHERE user_id = (select auth.uid())));
CREATE POLICY "cats_admin_update" ON public.categories FOR UPDATE
  USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = (select auth.uid())))
  WITH CHECK (EXISTS (SELECT 1 FROM public.admins WHERE user_id = (select auth.uid())));
CREATE POLICY "cats_admin_delete" ON public.categories FOR DELETE
  USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = (select auth.uid())));

DROP POLICY IF EXISTS "items admin write" ON public.category_items;
CREATE POLICY "items_admin_insert" ON public.category_items FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM public.admins WHERE user_id = (select auth.uid())));
CREATE POLICY "items_admin_update" ON public.category_items FOR UPDATE
  USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = (select auth.uid())))
  WITH CHECK (EXISTS (SELECT 1 FROM public.admins WHERE user_id = (select auth.uid())));
CREATE POLICY "items_admin_delete" ON public.category_items FOR DELETE
  USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = (select auth.uid())));

NOTIFY pgrst, 'reload schema';
