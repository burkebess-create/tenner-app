-- Notification queue for friend-update / new-comment / list-share emails.
-- Replaces the "fire immediately" behavior with a batched, cadence-aware
-- pipeline that also prevents "created a list then deleted it" from spamming.
--
-- Flow:
--   1. When a user updates a list / posts a comment / shares a list, the
--      client INSERTs a row into notification_queue (one per intended
--      recipient).
--   2. A cron (process-notifications edge fn, every 15 min) reads pending
--      rows created ≥1 hour ago, verifies the referenced list still exists,
--      groups them per recipient, applies the recipient's cadence
--      preference (immediate/daily/weekly), and sends a single digest
--      email per recipient per cycle.
--   3. Sent rows are stamped sent_at (dropped rows are stamped with a
--      reason for admin debugging).

CREATE TABLE IF NOT EXISTS public.notification_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  from_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  event_type text NOT NULL, -- 'friend_update' | 'new_comment' | 'list_share'
  event_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  dropped_at timestamptz,
  drop_reason text
);
CREATE INDEX IF NOT EXISTS notification_queue_pending_idx
  ON public.notification_queue(recipient_user_id, created_at)
  WHERE sent_at IS NULL AND dropped_at IS NULL;
CREATE INDEX IF NOT EXISTS notification_queue_created_idx
  ON public.notification_queue(created_at);

ALTER TABLE public.notification_queue ENABLE ROW LEVEL SECURITY;

-- Users can insert notifications targeting anyone (guards on from_user_id
-- being their own uid so nobody can spoof).
DROP POLICY IF EXISTS "Users insert their own notifications" ON public.notification_queue;
CREATE POLICY "Users insert their own notifications"
  ON public.notification_queue FOR INSERT
  TO authenticated
  WITH CHECK ((select auth.uid()) = from_user_id);

-- Users can read notifications sent TO them (for a possible future in-app
-- inbox). Not required today but harmless and enables future features.
DROP POLICY IF EXISTS "Users read their own notifications" ON public.notification_queue;
CREATE POLICY "Users read their own notifications"
  ON public.notification_queue FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = recipient_user_id);

-- Admins can view everything
DROP POLICY IF EXISTS "Admins can view all notification_queue" ON public.notification_queue;
CREATE POLICY "Admins can view all notification_queue"
  ON public.notification_queue FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = (select auth.uid())));

-- Cadence preference on user_email_prefs. Values: 'immediate' | 'daily' | 'weekly'
-- Default 'daily' — gentler than status quo, avoids notification fatigue.
ALTER TABLE public.user_email_prefs
  ADD COLUMN IF NOT EXISTS notification_cadence text NOT NULL DEFAULT 'daily';

NOTIFY pgrst, 'reload schema';
