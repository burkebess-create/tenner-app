-- Backfill display_name from the OAuth payload (2026-09-22)
--
-- Ten profiles had neither a display_name nor a handle, so they rendered to
-- everyone else as "Unknown" — and on a friend detail screen, as the literal
-- fallback title "Friend". Four were created the same morning; several had
-- photos, lists and recent sign-ins, so these were people actively using the
-- app while nameless, not abandoned signups.
--
-- Two separate causes:
--
--  1. The bottom nav stayed visible during onboarding. One tap on any tab
--     dropped you into the app with no name and no handle, and nothing ever
--     asked again. A back gesture did the same, since the popstate handler
--     had no onboarding guard. Both fixed in index.html; onboarding is now a
--     gate rather than a screen you can browse away from. Because
--     isOnboardingIncomplete() still returns true for these accounts, the
--     six who have no name anywhere are re-prompted on next load and can no
--     longer escape it.
--
--  2. Google sign-ups arrived with their real name sitting in
--     auth.users.raw_user_meta_data.full_name, and the client never read it —
--     `grep full_name index.html` returned nothing. loadProfile() now adopts
--     it when display_name is empty.
--
-- This statement is the one-time backfill for cause 2. Four rows updated:
-- Amber C, Cleola Bess, Mallory Jones, Kolton Baldwin. Names only; handles
-- were left alone, since a handle is a public identifier the user should pick.
--
-- Safe to re-run: the WHERE clause only touches rows that are still nameless.

update public.profiles p
set display_name = left(btrim(coalesce(
      nullif(btrim(u.raw_user_meta_data->>'full_name'), ''),
      u.raw_user_meta_data->>'name')), 60)
from auth.users u
where u.id = p.id
  and coalesce(nullif(btrim(p.display_name), ''), '') = ''
  and coalesce(nullif(btrim(u.raw_user_meta_data->>'full_name'), ''),
               nullif(btrim(u.raw_user_meta_data->>'name'), '')) is not null;
