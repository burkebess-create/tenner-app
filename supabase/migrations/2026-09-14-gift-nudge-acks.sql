-- 2026-09-14 — Gift nudges: acknowledge, then escalate at 7 and 3 days
--
-- The Gifts tab badge counted friends with a birthday in the next 14 days and
-- had no notion of "seen", so it sat lit for the whole fortnight and tapping
-- it did nothing. Every other badge in the app clears on view, so a number
-- that won't clear reads as broken.
--
-- Now: tapping the nudge tile on the Gifts page opens that friend's gift guide
-- and acknowledges the current window. The nudge returns once at 7 days and
-- once at 3 days, then stops for that birthday.
--
-- `tier` is the window acknowledged (14, 7 or 3). A friend counts again only
-- when they fall into a TIGHTER window than the one acknowledged, so an ack
-- at 3 ends it. Keyed by the year of the upcoming birthday, so next year
-- starts fresh — and a birthday that crosses New Year gets the correct year
-- because it is computed from today + daysUntil.
--
-- Server-side rather than localStorage so dismissing on a phone doesn't leave
-- the badge lit on a laptop, matching the existing friend_views table.
--
-- Verified under `set local role authenticated`: own insert allowed; the row
-- escalates 14 -> 7 on conflict; inserting for another viewer blocked (42501);
-- an out-of-range tier blocked by the check constraint (23514); only own rows
-- visible.

create table if not exists public.gift_nudge_acks (
  viewer_id uuid not null references auth.users(id) on delete cascade,
  friend_id uuid not null references auth.users(id) on delete cascade,
  bday_year smallint not null,
  tier      smallint not null check (tier in (3, 7, 14)),
  acked_at  timestamptz not null default now(),
  primary key (viewer_id, friend_id, bday_year)
);

alter table public.gift_nudge_acks enable row level security;

drop policy if exists gift_nudge_acks_own on public.gift_nudge_acks;
create policy gift_nudge_acks_own on public.gift_nudge_acks
  for all to authenticated
  using (viewer_id = auth.uid())
  with check (viewer_id = auth.uid());
