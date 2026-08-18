-- Comment thread read receipts
-- Track when each user last viewed a comment thread on a specific item.
-- Enables "Seen by @friend" indicators under the latest comment.

CREATE TABLE IF NOT EXISTS public.comment_thread_reads (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  list_owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category text NOT NULL,
  item_name text NOT NULL,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, list_owner_id, category, item_name)
);

CREATE INDEX IF NOT EXISTS idx_ctr_thread
  ON public.comment_thread_reads (list_owner_id, category, item_name);

ALTER TABLE public.comment_thread_reads ENABLE ROW LEVEL SECURITY;

-- Users can insert/update their own read receipt
DROP POLICY IF EXISTS "Users manage own reads" ON public.comment_thread_reads;
CREATE POLICY "Users manage own reads"
  ON public.comment_thread_reads FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Thread participants can see everyone's read receipts on that thread.
-- Uses the same helper we already installed for the comments policy.
DROP POLICY IF EXISTS "Thread participants see reads" ON public.comment_thread_reads;
CREATE POLICY "Thread participants see reads"
  ON public.comment_thread_reads FOR SELECT
  USING (
    public._is_thread_participant(list_owner_id, category, item_name)
    OR auth.uid() = list_owner_id
  );

NOTIFY pgrst, 'reload schema';
