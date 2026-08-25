-- Admin cross-user read access
-- Adds "admins can SELECT everything" policies to tables that gate reads by
-- user ownership. Non-admins are unaffected — RLS policies are OR'd, so
-- regular users still see only their own data via existing policies.
--
-- Run once. Safe to re-run (uses DROP IF EXISTS + CREATE).

-- friendships
DROP POLICY IF EXISTS "Admins can view all friendships" ON public.friendships;
CREATE POLICY "Admins can view all friendships"
  ON public.friendships FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()));

-- group_members
DROP POLICY IF EXISTS "Admins can view all group_members" ON public.group_members;
CREATE POLICY "Admins can view all group_members"
  ON public.group_members FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()));

-- groups
DROP POLICY IF EXISTS "Admins can view all groups" ON public.groups;
CREATE POLICY "Admins can view all groups"
  ON public.groups FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()));

-- lists
DROP POLICY IF EXISTS "Admins can view all lists" ON public.lists;
CREATE POLICY "Admins can view all lists"
  ON public.lists FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()));

-- list_reactions
DROP POLICY IF EXISTS "Admins can view all list_reactions" ON public.list_reactions;
CREATE POLICY "Admins can view all list_reactions"
  ON public.list_reactions FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()));

-- list_item_comments
DROP POLICY IF EXISTS "Admins can view all list_item_comments" ON public.list_item_comments;
CREATE POLICY "Admins can view all list_item_comments"
  ON public.list_item_comments FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()));

-- list_share_invites
DROP POLICY IF EXISTS "Admins can view all list_share_invites" ON public.list_share_invites;
CREATE POLICY "Admins can view all list_share_invites"
  ON public.list_share_invites FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()));

-- profiles
DROP POLICY IF EXISTS "Admins can view all profiles" ON public.profiles;
CREATE POLICY "Admins can view all profiles"
  ON public.profiles FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()));

-- feedback (in case it's not already covered)
DROP POLICY IF EXISTS "Admins can view all feedback" ON public.feedback;
CREATE POLICY "Admins can view all feedback"
  ON public.feedback FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()));

-- email_log
DROP POLICY IF EXISTS "Admins can view all email_log" ON public.email_log;
CREATE POLICY "Admins can view all email_log"
  ON public.email_log FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()));

-- user_email_prefs
DROP POLICY IF EXISTS "Admins can view all user_email_prefs" ON public.user_email_prefs;
CREATE POLICY "Admins can view all user_email_prefs"
  ON public.user_email_prefs FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()));

-- comment_thread_reads
DROP POLICY IF EXISTS "Admins can view all comment_thread_reads" ON public.comment_thread_reads;
CREATE POLICY "Admins can view all comment_thread_reads"
  ON public.comment_thread_reads FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()));

-- match_reveals (in case it exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'match_reveals') THEN
    EXECUTE 'DROP POLICY IF EXISTS "Admins can view all match_reveals" ON public.match_reveals';
    EXECUTE 'CREATE POLICY "Admins can view all match_reveals" ON public.match_reveals FOR SELECT USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()))';
  END IF;
END $$;

-- list_change_events (in case it exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'list_change_events') THEN
    EXECUTE 'DROP POLICY IF EXISTS "Admins can view all list_change_events" ON public.list_change_events';
    EXECUTE 'CREATE POLICY "Admins can view all list_change_events" ON public.list_change_events FOR SELECT USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()))';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
