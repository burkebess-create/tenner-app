-- Bound anonymous shop_clicks writes (2026-09-23)
--
-- Applied as: bound_anon_shop_clicks
--
-- "Anyone can insert shop_clicks" was WITH CHECK (true) for anon AND
-- authenticated — the identical hole harden_photo_and_analytics closed on
-- analytics_events on Sept 19, missed at the time because that audit was
-- looking at analytics. Anyone with the publishable key, which is in the page
-- source by design, could write unlimited rows of unlimited size. It predates
-- this work; /l.html and /shop.html added two more public pages writing to
-- it, which is what made it worth fixing now rather than later.
--
-- The LENGTH limits matter more than the row cap. Without them a single
-- insert can carry megabytes and a handful of requests becomes a storage
-- bill; real values are tens of bytes. The row cap only bounds how many such
-- requests land per hour.
--
-- user_id must be null for anon, so an anonymous caller can never attribute a
-- click to a real account.
--
-- from_user_id is deliberately STILL permitted for anon: /gifts/ pages set it
-- from the ?from= parameter to credit whoever shared the link, and requiring
-- null would silently break that attribution. It remains spoofable by anyone
-- reading the page source — worth knowing, not worth breaking the feature
-- over, since the worst case is a junk row in someone's referral view.
--
-- Volume: the busiest hour this table has ever seen is 7 rows. 300/hour is
-- ~40x real traffic, so only something that is not a person reaches it.
--
-- VERIFIED as anon, inside deliberately aborted transactions — the three real
-- insert shapes still work, the abuse shapes do not:
--   shop.html insert (source 'shop-page')          OK
--   /gifts/ insert with ?from= attribution         OK
--   gift-share insert (variable source token)      OK
--   anon attributing a row to a real user          blocked
--   50,000-character item value                    blocked
--   url = 'javascript:alert(1)'                    blocked
--   rate limit                                     tripped at insert #296
--                                                  with 5 already in the
--                                                  window (cap 300)
-- Confirmed afterwards that 0 probe rows survived.

create index if not exists idx_shop_clicks_anon_clicked
  on public.shop_clicks (clicked_at desc) where user_id is null;

create or replace function public.enforce_anon_shop_click_limit()
returns trigger
language plpgsql
security definer          -- anon cannot SELECT this table; the count needs to
set search_path to 'public'
as $$
declare v_global int;
begin
  if auth.uid() is not null or auth.role() <> 'anon' then
    return new;
  end if;
  select count(*) into v_global
    from public.shop_clicks
   where user_id is null and clicked_at > now() - interval '1 hour';
  if v_global >= 300 then
    raise exception 'Rate limit reached.' using errcode = '53400';
  end if;
  return new;
end $$;

revoke all on function public.enforce_anon_shop_click_limit() from public, anon, authenticated;

drop trigger if exists trg_anon_shop_click_limit on public.shop_clicks;
create trigger trg_anon_shop_click_limit
  before insert on public.shop_clicks
  for each row execute function public.enforce_anon_shop_click_limit();

drop policy if exists "Anyone can insert shop_clicks" on public.shop_clicks;

create policy shop_clicks_insert_anon on public.shop_clicks
  for insert to anon
  with check (
    user_id is null
    and coalesce(length(url), 0)        <= 2048
    and coalesce(length(source), 0)     <= 64
    and coalesce(length(category), 0)   <= 120
    and coalesce(length(item), 0)       <= 300
    and coalesce(length(query), 0)      <= 400
    and coalesce(length(retailer), 0)   <= 40
    and coalesce(length(referer), 0)    <= 512
    and coalesce(length(user_agent), 0) <= 512
    and (url is null or url like 'https://%')
  );

-- Signed-in callers may attribute a row to themselves and nobody else.
create policy shop_clicks_insert_authenticated on public.shop_clicks
  for insert to authenticated
  with check (
    (user_id is null or user_id = (select auth.uid()))
    and coalesce(length(url), 0)    <= 2048
    and coalesce(length(source), 0) <= 64
    and coalesce(length(item), 0)   <= 300
    and coalesce(length(query), 0)  <= 400
  );
