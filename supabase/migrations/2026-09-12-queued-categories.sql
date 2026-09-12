-- 2026-09-12 — Queued categories
--
-- The Create screen shows the first 8 non-retired, in-season categories (by
-- sort_order) that the user does not already have a list for. Categories past
-- that point sit "in waiting" and rotate in as users fill lists out, so
-- sort_order alone defines both the visible slots and the queue behind them.
-- Admins reorder via the ↑/↓ controls in the admin Categories tab, which
-- rewrites sort_order sequentially (1..N across active categories).
--
-- Seeds the first two queued categories. Idempotent.

insert into public.categories (name, emoji, sort_order)
select v.name, v.emoji, v.sort_order
from (values
  ('Bucket-List Experiences',           '🌄', 9),
  ('Things I Want But Haven''t Bought', '🛒', 10)
) as v(name, emoji, sort_order)
where not exists (
  select 1 from public.categories c where lower(c.name) = lower(v.name)
);
