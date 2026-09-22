-- Signed-out funnel analytics, without reopening the hole (2026-09-22)
--
-- Applied as: anon_analytics_allowlist_with_rate_limit
--
-- harden_photo_and_analytics (2026-09-19, finding 5) restricted
-- analytics_events inserts to `authenticated`, because the previous policy was
-- WITH CHECK (true): anyone holding the publishable key — which is in the page
-- source by design — could write unlimited rows with no account. That is a
-- denial-of-wallet on storage and it poisons the data. The restriction was
-- right.
--
-- The side effect went unnoticed for three days. A first-time visitor on the
-- welcome page is BY DEFINITION signed out, so the entire top of the funnel
-- stopped recording: welcome_view ran at 8-15/day through Sept 19 and was
-- exactly zero on Sept 20, 21 and 22. Every one of those 401s in the QA
-- warnings was a real person landing on the marketing page. "No clicks
-- recorded" was not evidence of no clicks.
--
-- Anon may insert again, but only inside a box:
--   * three event names, nothing else
--   * user_id must be null — it cannot attribute a row to someone else
--   * session_id required and bounded in length
--   * 60 rows/hour per session, 600/hour across all anonymous traffic
--
-- The GLOBAL cap is the one that actually bounds abuse, since an attacker
-- rotates session_id freely. At 8-15 landing views a day it sits ~40x above
-- real traffic, so only something that is not a visitor can reach it.
--
-- Reading is untouched: analytics_events_admin_select is still the only SELECT
-- policy. Verified as anon that 0 of 4173 rows are visible.
--
-- VERIFIED as anon, inside deliberately aborted transactions:
--   welcome_view insert            OK
--   event off the allowlist        blocked
--   row attributed to a real user  blocked
--   missing session_id             blocked
--   select                         0 rows of 4173
--   per-session rate limit         tripped on insert #61 (cap 60)
-- Confirmed afterwards that no probe rows survived.

create index if not exists idx_analytics_events_anon_session
  on public.analytics_events (session_id, created_at desc)
  where user_id is null;

create index if not exists idx_analytics_events_anon_created
  on public.analytics_events (created_at desc)
  where user_id is null;

create or replace function public.enforce_anon_analytics_rate_limit()
returns trigger
language plpgsql
security definer          -- anon cannot SELECT this table; the count needs to
set search_path to 'public'
as $$
declare
  v_session int;
  v_global  int;
begin
  -- Signed-in users and service_role jobs are not this policy's problem.
  if auth.uid() is not null or auth.role() <> 'anon' then
    return new;
  end if;

  select count(*) into v_session
  from public.analytics_events
  where user_id is null
    and session_id = new.session_id
    and created_at > now() - interval '1 hour';
  if v_session >= 60 then
    raise exception 'Rate limit reached for this session.' using errcode = '53400';
  end if;

  select count(*) into v_global
  from public.analytics_events
  where user_id is null
    and created_at > now() - interval '1 hour';
  if v_global >= 600 then
    raise exception 'Rate limit reached.' using errcode = '53400';
  end if;

  return new;
end $$;

revoke all on function public.enforce_anon_analytics_rate_limit() from public, anon, authenticated;

drop trigger if exists trg_anon_analytics_rate_limit on public.analytics_events;
create trigger trg_anon_analytics_rate_limit
  before insert on public.analytics_events
  for each row execute function public.enforce_anon_analytics_rate_limit();

drop policy if exists analytics_events_insert_anon on public.analytics_events;
create policy analytics_events_insert_anon on public.analytics_events
  for insert to anon
  with check (
    user_id is null
    and event in ('welcome_view', 'welcome_cta_click', 'signup_started')
    and session_id is not null
    and length(session_id) between 6 and 64
  );
