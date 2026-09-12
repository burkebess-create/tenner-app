-- 2026-09-12 — Mark JS errors as resolved
--
-- Errors in the admin tile are grouped by message, so a resolution is keyed on
-- message too.
--
-- resolved_at is a TIMESTAMP rather than a boolean on purpose: an error counts
-- as resolved only while nothing new has happened since it was marked. If the
-- same error fires again afterwards, last_seen moves past resolved_at and it
-- returns to the active list flagged as a regression. A plain boolean would
-- have hidden a recurrence permanently — the one failure mode that matters
-- here, since the whole point is to trust that the list shows real problems.
--
-- The UI excludes resolved rows from the headline hit/user stats (they would
-- otherwise inflate them forever) but keeps each row's own counts on its card
-- as a record of how many people were affected.
--
-- Verified under `set local role authenticated`:
--   non-admin calling admin_resolve_error   -> blocked (admin_only)
--   admin resolves, last hit before mark    -> counts as resolved
--   same error recurs after the mark        -> counts as UNresolved (reopens)
--   admin_unresolve_error                   -> row removed
-- (The recurrence check initially read as a false pass because every now() in
-- one transaction is identical; re-run with explicit timestamps to confirm.)

create table if not exists public.error_resolutions (
  message     text primary key,
  resolved_at timestamptz not null default now(),
  resolved_by uuid null references auth.users(id) on delete set null,
  note        text null
);

alter table public.error_resolutions enable row level security;

drop policy if exists error_resolutions_admin_all on public.error_resolutions;
create policy error_resolutions_admin_all on public.error_resolutions
  for all to authenticated
  using      (exists (select 1 from public.admins a where a.user_id = auth.uid()))
  with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));

-- Return type gains resolved_at/resolved_note, so the old signature must be
-- dropped first — CREATE OR REPLACE cannot change OUT parameters.
drop function if exists public.admin_get_error_summary(integer);

create function public.admin_get_error_summary(days integer default 7)
returns table(
  message text, hits bigint, users bigint,
  first_seen timestamptz, last_seen timestamptz,
  sample_stack text, sample_path text,
  resolved_at timestamptz, resolved_note text
)
language sql stable security definer set search_path to 'public'
as $function$
  with recent as (
    select
      coalesce(nullif(meta->>'message',''), '(no message)') as message,
      user_id,
      created_at,
      meta->>'stack'    as stack,
      meta->>'pathname' as pathname
    from analytics_events
    where event = 'js_error'
      and created_at >= now() - make_interval(days => greatest(days,1))
      and exists (select 1 from admins where user_id = auth.uid())
  ),
  grouped as (
    select
      message,
      count(*)::bigint                as hits,
      count(distinct user_id)::bigint as users,
      min(created_at)                 as first_seen,
      max(created_at)                 as last_seen,
      (array_agg(stack order by created_at desc) filter (where stack is not null))[1] as sample_stack,
      (array_agg(pathname order by created_at desc) filter (where pathname is not null))[1] as sample_path
    from recent
    group by message
  )
  select g.message, g.hits, g.users, g.first_seen, g.last_seen,
         g.sample_stack, g.sample_path,
         r.resolved_at, r.note
  from grouped g
  left join error_resolutions r on r.message = g.message
  order by g.hits desc, g.last_seen desc
  limit 200;
$function$;

create or replace function public.admin_resolve_error(p_message text, p_note text default null)
returns void language plpgsql security definer set search_path to 'public'
as $$
begin
  if not exists (select 1 from admins where user_id = auth.uid()) then
    raise exception 'admin_only';
  end if;
  insert into error_resolutions (message, resolved_at, resolved_by, note)
  values (p_message, now(), auth.uid(), nullif(btrim(coalesce(p_note,'')), ''))
  on conflict (message) do update
    set resolved_at = now(), resolved_by = auth.uid(), note = excluded.note;
end $$;

create or replace function public.admin_unresolve_error(p_message text)
returns void language plpgsql security definer set search_path to 'public'
as $$
begin
  if not exists (select 1 from admins where user_id = auth.uid()) then
    raise exception 'admin_only';
  end if;
  delete from error_resolutions where message = p_message;
end $$;

revoke all on function public.admin_get_error_summary(integer)  from public, anon;
revoke all on function public.admin_resolve_error(text, text)   from public, anon;
revoke all on function public.admin_unresolve_error(text)       from public, anon;
grant execute on function public.admin_get_error_summary(integer) to authenticated;
grant execute on function public.admin_resolve_error(text, text)  to authenticated;
grant execute on function public.admin_unresolve_error(text)      to authenticated;
