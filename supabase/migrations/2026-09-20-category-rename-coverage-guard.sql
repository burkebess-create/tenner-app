-- Category rename coverage guard (2026-09-20)
--
-- Applied as two migrations:
--   category_rename_coverage_guard
--   rename_category_everywhere_coverage_check
--
-- WHY: a category is identified by its text name, with no foreign key on any
-- of the tables that store one. rename_category_everywhere() therefore has to
-- update all ten of them by hand, plus a jsonb array on profiles. Nothing
-- stopped an eleventh table being added later and silently orphaned by every
-- rename — its rows would keep the old category name forever and detach from
-- the list they belong to.
--
-- HOW: the covered set is derived from the rename function's OWN BODY
-- (matching "update <table> set"), so the check and the function cannot
-- drift. Add an UPDATE and the table is covered automatically; add a table
-- with a category column and no UPDATE and the next rename refuses to run.
--
-- Tables whose "category" means something else go in
-- category_rename_exempt_tables. Seeded with feedback, whose category column
-- holds a feedback TYPE ('idea', 'bug') — verified against live data.
--
--   public._category_rename_coverage_gaps()     internal, no grants; returns
--                                               uncovered tables. Called from
--                                               inside the rename function,
--                                               which runs as its owner, so
--                                               no grant is needed. (Learned
--                                               the hard way with
--                                               are_friends: a function used
--                                               inside an RLS POLICY is the
--                                               opposite case and DOES need
--                                               EXECUTE for the caller.)
--
--   public.admin_category_rename_coverage()     admin-gated report of every
--                                               table storing a category and
--                                               whether a rename reaches it.
--                                               Granted to authenticated,
--                                               checks admins inside.
--
-- The rename function now calls the gap check first and raises before
-- touching any data if coverage is incomplete. Its signature is unchanged,
-- INCLUDING the defaults on p_old_emoji/p_new_emoji — CREATE OR REPLACE
-- cannot drop parameter defaults, and categories_rename_trigger() depends on
-- the four-arg form.
--
-- VERIFIED (all inside deliberately aborted transactions; residue re-checked
-- afterwards and was zero, with the 15 'Movies' lists intact):
--
--   gaps on today's schema                        0
--   normal rename Zzzold -> Zzznew                works, and cascaded to
--                                                 list_reactions (1 row)
--   after CREATE TABLE zzz_new_feature(category)  1 gap reported
--   rename with that gap present                  BLOCKED, naming the table
--   after exempting it                            rename works again
--
--   as a NON-admin: admin_category_rename_coverage()  REFUSED
--                   _category_rename_coverage_gaps()  REFUSED
--                   rename_category_everywhere()      REFUSED
--
-- Current report (10 covered, 1 exempt, 0 gaps):
--   covered: comment_thread_reads, group_lists, list_change_events,
--            list_item_comments, list_reactions, list_share_invites, lists,
--            match_reveals, shop_clicks, weekly_lists
--   exempt:  feedback
--
-- To read the report yourself:
--   select * from public.admin_category_rename_coverage();
--
-- Definitions live in the Supabase migration history. Not reproduced in full
-- here because the rename function body is long and duplicating it invites
-- exactly the drift this guard exists to prevent — read it from the database
-- with:
--   select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'rename_category_everywhere';

create table if not exists public.category_rename_exempt_tables (
  table_name text primary key,
  reason     text not null,
  added_at   timestamptz not null default now()
);

insert into public.category_rename_exempt_tables (table_name, reason)
values ('feedback', 'category column is a feedback type (idea/bug), not a list category')
on conflict (table_name) do nothing;

alter table public.category_rename_exempt_tables enable row level security;
-- No policy: only the service role and SECURITY DEFINER functions read it.

-- ── Admin UI, 2026-09-20 ──────────────────────────────────────────────
-- admin_category_rename_coverage() is now surfaced in the app, at the top of
-- Admin → Categories: a one-line status strip directly above the category
-- list, which is where renames are actually performed. Green when every
-- table is covered, red and naming the offenders when not, with a Details
-- toggle listing the covered and exempt tables as chips.
--
-- It renders after the category list rather than blocking on it, so a schema
-- check never slows the tab down.
--
-- Render states verified against the live RPC shape: healthy, healthy with
-- details expanded, a synthetic gap, an RPC error (retry offered), and zero
-- rows — the last treated as "could not check" rather than "OK, 0 tables",
-- since lists alone should always come back.
