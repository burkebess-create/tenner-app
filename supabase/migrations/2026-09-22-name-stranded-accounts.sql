-- Names for the accounts stranded without one (2026-09-22)
--
-- Companion to 2026-09-22-backfill-oauth-display-names.sql. That one
-- recovered names the Google sign-up payload already carried. These four
-- signed up by email, so there was no name anywhere to recover — they
-- rendered to their whole circle as "A friend" and "Unknown", one of them
-- while actively posting lists.
--
-- The names below were supplied by the account owner; they are NOT derived
-- from the email address. Deriving them would have produced "Anna Wiser"
-- correctly and "Hjcrochetdesigns" for the next one along, which is why it
-- was not done automatically.
--
-- Handles are deliberately left null. A handle is a public identifier people
-- are addressed by, so each user picks their own the next time they open the
-- app — which they now will, because startOnboardingIfNeeded() runs on
-- returning sessions and not only on a fresh sign-in.
--
-- Guarded on display_name still being empty, so re-running cannot overwrite a
-- name the user has since chosen.

update public.profiles p
set display_name = v.name
from (values
  ('anna.wiser@icloud.com',       'Anna Wiser'),
  ('lisaapmercer@gmail.com',      'Lisa Mercer'),
  ('hjcrochetdesigns@gmail.com',  'Heidi Jacobs'),
  ('jennametcalf99@hotmail.com',  'Jenna Dilworth')
) as v(email, name)
where p.id = (select u.id from auth.users u where lower(u.email) = v.email)
  and coalesce(nullif(btrim(p.display_name), ''), '') = '';

-- Applied 2026-09-22. Four rows updated. Profiles with no display_name went
-- from 10 → 2; the remaining two (kellie.michelle93@gmail.com,
-- karlyn.tejada@outlook.com) have never posted anything and one has never
-- signed in, so they are left to onboarding.
