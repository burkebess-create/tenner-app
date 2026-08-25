-- Push notification subscriptions
-- One row per (user, device/browser). Endpoint is unique — the browser gives
-- us the same endpoint if the user re-subscribes on the same device.

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_id_idx
  ON public.push_subscriptions(user_id);

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Users manage their own subscriptions
DROP POLICY IF EXISTS "Users can view own push_subscriptions" ON public.push_subscriptions;
CREATE POLICY "Users can view own push_subscriptions"
  ON public.push_subscriptions FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own push_subscriptions" ON public.push_subscriptions;
CREATE POLICY "Users can insert own push_subscriptions"
  ON public.push_subscriptions FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own push_subscriptions" ON public.push_subscriptions;
CREATE POLICY "Users can delete own push_subscriptions"
  ON public.push_subscriptions FOR DELETE
  USING (auth.uid() = user_id);

-- Admins can see everything (matches pattern from 2026-08-24-admin-read-all)
DROP POLICY IF EXISTS "Admins can view all push_subscriptions" ON public.push_subscriptions;
CREATE POLICY "Admins can view all push_subscriptions"
  ON public.push_subscriptions FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()));

-- Add push toggle to user_email_prefs.prefs (used by send-push to gate delivery)
-- Default: null/undefined => enabled (opt-out model, same as email)

NOTIFY pgrst, 'reload schema';
