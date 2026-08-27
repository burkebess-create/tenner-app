-- Handle aliases: users can change their @handle, but the old handle keeps
-- routing to them forever (or until they run out of alias slots).
--
-- Design:
--   • profiles.handle = the current handle (unchanged behavior)
--   • handle_aliases  = every retired handle → its owner
--   • Trigger auto-inserts the old handle into aliases when profiles.handle
--     changes, so app code just does an UPDATE profiles SET handle=…
--   • Uniqueness enforced across BOTH tables: signup / search checks must
--     query profiles.handle UNION handle_aliases.handle
--   • Cap: max 5 retired handles per user (oldest evicted on 6th change)
--   • Cooldown: 30 days between changes, enforced client-side; also stamp
--     profiles.handle_changed_at so admin/audit can see it.

-- ── Column on profiles for cooldown tracking ─────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS handle_changed_at timestamptz;

-- ── Aliases table ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.handle_aliases (
  handle text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS handle_aliases_user_id_idx ON public.handle_aliases(user_id);

ALTER TABLE public.handle_aliases ENABLE ROW LEVEL SECURITY;

-- Anyone signed in can read aliases (needed for search + uniqueness checks).
DROP POLICY IF EXISTS "Anyone can read handle_aliases" ON public.handle_aliases;
CREATE POLICY "Anyone can read handle_aliases"
  ON public.handle_aliases FOR SELECT
  TO authenticated
  USING (true);

-- Only the trigger writes to this table; direct client writes are blocked.
-- (No INSERT/UPDATE/DELETE policies → no client mutation possible.)

-- Admins can see everything (mirrors the pattern from 2026-08-24-admin-read-all)
DROP POLICY IF EXISTS "Admins can view all handle_aliases" ON public.handle_aliases;
CREATE POLICY "Admins can view all handle_aliases"
  ON public.handle_aliases FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()));

-- ── Trigger: on handle change, retire the old handle ────────────────
CREATE OR REPLACE FUNCTION public.retire_old_handle()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  alias_count int;
  oldest_alias text;
BEGIN
  -- Only act when handle actually changes to a non-null new value
  IF NEW.handle IS DISTINCT FROM OLD.handle AND OLD.handle IS NOT NULL THEN
    -- Refuse if the new handle is already in aliases owned by someone else
    IF EXISTS (SELECT 1 FROM public.handle_aliases WHERE handle = NEW.handle AND user_id <> NEW.id) THEN
      RAISE EXCEPTION 'Handle "%" is already taken by another user (retired)', NEW.handle;
    END IF;

    -- Enforce max 5 aliases per user — evict the oldest if at cap
    SELECT count(*) INTO alias_count FROM public.handle_aliases WHERE user_id = NEW.id;
    IF alias_count >= 5 THEN
      SELECT handle INTO oldest_alias FROM public.handle_aliases
        WHERE user_id = NEW.id ORDER BY created_at ASC LIMIT 1;
      DELETE FROM public.handle_aliases WHERE handle = oldest_alias;
    END IF;

    -- If the NEW handle used to be one of this user's own aliases, free it
    DELETE FROM public.handle_aliases WHERE handle = NEW.handle AND user_id = NEW.id;

    -- Retire the old handle
    INSERT INTO public.handle_aliases (handle, user_id) VALUES (OLD.handle, NEW.id)
      ON CONFLICT (handle) DO NOTHING;

    -- Stamp the change time
    NEW.handle_changed_at := now();
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS profiles_retire_old_handle ON public.profiles;
CREATE TRIGGER profiles_retire_old_handle
  BEFORE UPDATE OF handle ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.retire_old_handle();

-- ── Prevent someone from CLAIMING a handle already in aliases ────────
-- Blocks INSERTs and any UPDATE where the new handle collides with an
-- alias belonging to a different user.
CREATE OR REPLACE FUNCTION public.check_handle_not_retired()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.handle IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.handle_aliases
    WHERE handle = NEW.handle AND user_id <> NEW.id
  ) THEN
    RAISE EXCEPTION 'Handle "%" is retired and belongs to another user', NEW.handle;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS profiles_check_retired ON public.profiles;
CREATE TRIGGER profiles_check_retired
  BEFORE INSERT OR UPDATE OF handle ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.check_handle_not_retired();

-- ── One-off: change @burke1 → @burke (auto-retires @burke1) ──────────
UPDATE public.profiles SET handle = 'burke' WHERE handle = 'burke1';

NOTIFY pgrst, 'reload schema';
