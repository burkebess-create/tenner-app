-- 2026-09-18 — Test-mode gate for the lifecycle emails
--
-- Lives in the database rather than in the edge function so that switching
-- from a test send to the real one is a single UPDATE, not a redeploy.
--
-- While lifecycle_test_emails is a non-empty array, runLifecycleEmails():
--   * sends ONLY to those addresses,
--   * sends all four stages to each — an admin account typically qualifies
--     for none of them, so stage-based selection would send nothing to
--     review (verified: the owner account has 22 lists, friends with
--     matches and a birthday set, so pickLifecycleStage returns null),
--   * prefixes subjects with "[TEST] ",
--   * and writes NO email_log rows, so a test can never burn a real user's
--     once-ever send.
-- Setting it back to '[]' restores normal behaviour with no redeploy.
--
-- Service-role only: the edge function reads it with the service key. No
-- policy is added and RLS is enabled, so anon/authenticated cannot read or
-- write it at all.
--
-- Verified live: with ["burkebess@gmail.com"] set, an invocation returned
-- lifecycle_sent: 4 and email_log gained 0 rows.

create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;

revoke all on public.app_settings from anon, authenticated;

insert into public.app_settings (key, value)
values ('lifecycle_test_emails', '[]'::jsonb)
on conflict (key) do nothing;

-- To go live:
--   update public.app_settings set value = '[]'::jsonb, updated_at = now()
--   where key = 'lifecycle_test_emails';
