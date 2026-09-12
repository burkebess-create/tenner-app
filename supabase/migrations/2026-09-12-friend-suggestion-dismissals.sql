-- 2026-09-12 — Dismissable "People you may know" suggestions
--
-- Lets a user remove someone from their suggestions permanently. Stored
-- server-side rather than in localStorage so the dismissal follows them
-- across devices.
--
-- A dismissal is private and one-directional: only the person who made it can
-- read, create or delete it, and the dismissed user is never notified. Nothing
-- about the dismissed account changes — they can still be found by search and
-- added later, and they can still send a request the other way.
--
-- Verified under `set local role authenticated`: own insert allowed, inserting
-- a row for another user blocked (42501), only own rows visible, own delete
-- (the undo path) allowed.

create table if not exists public.friend_suggestion_dismissals (
  user_id      uuid not null references auth.users(id) on delete cascade,
  dismissed_id uuid not null references auth.users(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (user_id, dismissed_id)
);

alter table public.friend_suggestion_dismissals enable row level security;

drop policy if exists fsd_select_own on public.friend_suggestion_dismissals;
create policy fsd_select_own on public.friend_suggestion_dismissals
  for select to authenticated using (user_id = auth.uid());

drop policy if exists fsd_insert_own on public.friend_suggestion_dismissals;
create policy fsd_insert_own on public.friend_suggestion_dismissals
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists fsd_delete_own on public.friend_suggestion_dismissals;
create policy fsd_delete_own on public.friend_suggestion_dismissals
  for delete to authenticated using (user_id = auth.uid());
