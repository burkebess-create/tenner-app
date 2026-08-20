-- User email preference center
-- One row per user. `prefs` is a jsonb of category → boolean.
-- Recognized categories: 'social', 'weekly', 'reminders', 'product'.
-- Missing key = treated as true (opted in). Essential emails (welcome,
-- feedback_update, security) always send regardless — they're transactional.
--
-- Each user also gets a random unsubscribe_token used for one-click
-- unsubscribe links in email footers (works without being logged in).

CREATE TABLE IF NOT EXISTS public.user_email_prefs (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  prefs jsonb NOT NULL DEFAULT '{}'::jsonb,
  unsubscribe_token text UNIQUE NOT NULL DEFAULT (
    substr(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 1, 24)
  ),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_email_prefs_token
  ON public.user_email_prefs (unsubscribe_token);

ALTER TABLE public.user_email_prefs ENABLE ROW LEVEL SECURITY;

-- Users read/write their own row
DROP POLICY IF EXISTS "Users manage own email prefs" ON public.user_email_prefs;
CREATE POLICY "Users manage own email prefs"
  ON public.user_email_prefs FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────────
-- Token-based unsubscribe RPC (works for anonymous callers so email
-- links can unsubscribe with a single tap, without login).
-- Set category='all' to unsubscribe from everything non-essential.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.unsubscribe_by_token(
  p_token text,
  p_category text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_uid uuid;
  current_prefs jsonb;
BEGIN
  IF p_token IS NULL OR length(p_token) < 8 THEN
    RETURN false;
  END IF;
  SELECT user_id, prefs INTO target_uid, current_prefs
    FROM public.user_email_prefs
    WHERE unsubscribe_token = p_token;
  IF target_uid IS NULL THEN
    RETURN false;
  END IF;
  IF p_category IS NULL OR p_category = 'all' THEN
    current_prefs := jsonb_build_object(
      'social', false,
      'weekly', false,
      'reminders', false,
      'product', false
    );
  ELSE
    current_prefs := coalesce(current_prefs, '{}'::jsonb)
      || jsonb_build_object(p_category, false);
  END IF;
  UPDATE public.user_email_prefs
    SET prefs = current_prefs, updated_at = now()
    WHERE user_id = target_uid;
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.unsubscribe_by_token(text, text) TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- Helper: does this user allow this email category? Used by the
-- send-email edge function (via service role) to gate sends.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.email_pref_allows(
  p_user_id uuid,
  p_category text
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT (prefs->>p_category)::boolean FROM public.user_email_prefs WHERE user_id = p_user_id),
    true  -- default: opted in
  );
$$;

GRANT EXECUTE ON FUNCTION public.email_pref_allows(uuid, text) TO anon, authenticated, service_role;

-- Auto-create prefs row (with random token) whenever a new user signs up
CREATE OR REPLACE FUNCTION public._create_email_prefs_for_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.user_email_prefs (user_id) VALUES (NEW.id)
    ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_create_email_prefs ON auth.users;
CREATE TRIGGER trg_create_email_prefs
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public._create_email_prefs_for_new_user();

-- Backfill existing users (each gets their own random token)
INSERT INTO public.user_email_prefs (user_id)
  SELECT id FROM auth.users
  ON CONFLICT (user_id) DO NOTHING;

NOTIFY pgrst, 'reload schema';
