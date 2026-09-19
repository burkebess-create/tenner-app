-- 2026-09-19 — Two-way feedback conversations
--
-- Feedback was one-shot: someone wrote in, an admin flipped a status, and the
-- submitter got a fixed template. There was no way to thank them in your own
-- words, ask what they meant, or check whether a fix actually solved it — and
-- no way for them to answer if you did.
--
-- feedback_replies turns each feedback row into a thread. Admin messages are
-- emailed to the submitter; submitter replies surface in the admin inbox.
--
-- 'awaiting_user' joins new / in_progress / resolved: the ball is with the
-- submitter. Kept as free text like the existing values rather than promoted
-- to an enum, because the column already holds free text and a type change
-- would need every existing row and query migrated for no real gain.
--
-- Verified under `set local role authenticated` for three identities:
--   admin      can post an admin reply on anyone's feedback
--   submitter  sees their thread, can reply as themselves, is BLOCKED from
--              posting with is_admin=true, and BLOCKED from editing any body
--   stranger   sees zero rows and cannot insert

create table if not exists public.feedback_replies (
  id          uuid primary key default gen_random_uuid(),
  feedback_id uuid not null references public.feedback(id) on delete cascade,
  author_id   uuid references auth.users(id) on delete set null,
  is_admin    boolean not null default false,
  body        text not null check (length(btrim(body)) > 0 and length(body) <= 4000),
  created_at  timestamptz not null default now(),
  read_by_user_at  timestamptz,
  read_by_admin_at timestamptz
);

create index if not exists feedback_replies_feedback_id_idx
  on public.feedback_replies (feedback_id, created_at);

alter table public.feedback_replies enable row level security;

drop policy if exists feedback_replies_select on public.feedback_replies;
create policy feedback_replies_select on public.feedback_replies
  for select using (
    exists (select 1 from public.feedback f
            where f.id = feedback_id and f.user_id = (select auth.uid()))
    or exists (select 1 from public.admins a where a.user_id = (select auth.uid()))
  );

-- is_admin is checked against the admins table rather than trusted from the
-- client, so a user cannot post a reply styled as an official one.
drop policy if exists feedback_replies_insert on public.feedback_replies;
create policy feedback_replies_insert on public.feedback_replies
  for insert with check (
    author_id = (select auth.uid())
    and (
      (is_admin = false and exists (
        select 1 from public.feedback f
        where f.id = feedback_id and f.user_id = (select auth.uid())))
      or
      (is_admin = true and exists (
        select 1 from public.admins a where a.user_id = (select auth.uid())))
    )
  );

drop policy if exists feedback_replies_update on public.feedback_replies;
create policy feedback_replies_update on public.feedback_replies
  for update using (
    exists (select 1 from public.feedback f
            where f.id = feedback_id and f.user_id = (select auth.uid()))
    or exists (select 1 from public.admins a where a.user_id = (select auth.uid()))
  );

create or replace function public.feedback_replies_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.body is distinct from old.body
     or new.feedback_id is distinct from old.feedback_id
     or new.author_id is distinct from old.author_id
     or new.is_admin is distinct from old.is_admin
     or new.created_at is distinct from old.created_at then
    raise exception 'feedback_replies: only read markers may be updated';
  end if;
  return new;
end $$;

drop trigger if exists trg_feedback_replies_guard on public.feedback_replies;
create trigger trg_feedback_replies_guard
  before update on public.feedback_replies
  for each row execute function public.feedback_replies_guard();

drop policy if exists feedback_owner_answer on public.feedback;
create policy feedback_owner_answer on public.feedback
  for update using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and status in ('new', 'in_progress', 'awaiting_user'));
