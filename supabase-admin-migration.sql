-- ============================================================
-- Tenner Admin Phase 1 Migration
-- Run this in the Supabase SQL editor.
-- Safe to run multiple times (uses IF NOT EXISTS / on conflict).
-- ============================================================

-- --- Tables ---------------------------------------------------

create table if not exists categories (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  emoji text not null default '📋',
  is_seasonal boolean default false,
  active_from text,          -- 'MM-DD' string, year-agnostic
  active_to   text,          -- 'MM-DD' string, year-agnostic
  sort_order  int default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists category_items (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references categories(id) on delete cascade,
  item_text text not null,
  sort_order int default 0,
  created_at timestamptz default now()
);
create index if not exists ci_cat_idx on category_items(category_id);

create table if not exists feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  user_email text,
  message text not null,
  category text,             -- 'bug', 'idea', 'other'
  status text default 'new', -- 'new', 'in_progress', 'resolved'
  created_at timestamptz default now()
);

create table if not exists admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz default now()
);

-- --- Bootstrap the first admin (you) --------------------------
-- Change the email below if yours isn't burkebess@gmail.com.
insert into admins (user_id, email)
select id, email from auth.users where email = 'burkebess@gmail.com'
on conflict (user_id) do nothing;

-- --- Row Level Security ---------------------------------------

alter table categories       enable row level security;
alter table category_items   enable row level security;
alter table feedback         enable row level security;
alter table admins           enable row level security;

-- Anyone authenticated can READ categories & items.
drop policy if exists "cats read"  on categories;
drop policy if exists "items read" on category_items;
create policy "cats read"  on categories       for select using (auth.role() = 'authenticated');
create policy "items read" on category_items   for select using (auth.role() = 'authenticated');

-- Only admins can WRITE categories & items.
drop policy if exists "cats admin write"  on categories;
drop policy if exists "items admin write" on category_items;
create policy "cats admin write" on categories for all
  using      (exists (select 1 from admins where user_id = auth.uid()))
  with check (exists (select 1 from admins where user_id = auth.uid()));
create policy "items admin write" on category_items for all
  using      (exists (select 1 from admins where user_id = auth.uid()))
  with check (exists (select 1 from admins where user_id = auth.uid()));

-- Feedback: authenticated users insert; users see their own; admins see all.
drop policy if exists "feedback insert"    on feedback;
drop policy if exists "feedback own read"  on feedback;
drop policy if exists "feedback admin all" on feedback;
create policy "feedback insert"    on feedback for insert with check (auth.uid() = user_id);
create policy "feedback own read"  on feedback for select using      (auth.uid() = user_id);
create policy "feedback admin all" on feedback for all
  using      (exists (select 1 from admins where user_id = auth.uid()))
  with check (exists (select 1 from admins where user_id = auth.uid()));

-- Admins table: readable only by the admin themselves (used to detect admin status client-side).
drop policy if exists "admins read self" on admins;
create policy "admins read self" on admins for select using (auth.uid() = user_id);

-- --- Seed categories & autofill items --------------------------

insert into categories (name, emoji, sort_order) values
  ('Movies',      '🎬', 1),
  ('Candy Bars',  '🍫', 2),
  ('Travel',      '✈️', 3),
  ('TV Shows',    '📺', 4),
  ('Restaurants', '🍽️', 5),
  ('Sodas',       '🥤', 6),
  ('Songs',       '🎵', 7),
  ('Books',       '📚', 8)
on conflict (name) do nothing;

-- Seed items only if that category has no items yet.
do $$
declare
  cat record;
  vals text[];
  v text;
  n int;
begin
  for cat in select * from categories loop
    if exists (select 1 from category_items where category_id = cat.id) then
      continue;
    end if;
    vals := case cat.name
      when 'Movies'      then array['The Godfather','The Dark Knight','Inception','Interstellar','Pulp Fiction','Forrest Gump','The Shawshank Redemption','Goodfellas','The Matrix','Fight Club','Titanic','Avengers: Endgame','Jurassic Park','Star Wars']
      when 'Candy Bars'  then array['Snickers','Reese''s Peanut Butter Cups','Kit Kat','Butterfinger','Twix','M&Ms','Milky Way','Mars Bar','Baby Ruth','Crunch Bar','Almond Joy','100 Grand']
      when 'Travel'      then array['Paris, France','Bali, Indonesia','Tokyo, Japan','Maui, Hawaii','Santorini, Greece','Rome, Italy','New York City','Maldives','Barcelona, Spain','Iceland']
      when 'TV Shows'    then array['Breaking Bad','Game of Thrones','The Office','Stranger Things','Friends','The Wire','Succession','Seinfeld','Ted Lasso','Severance']
      when 'Restaurants' then array['Olive Garden','Texas Roadhouse','Cheesecake Factory','Chick-fil-A','Chipotle','In-N-Out Burger','Five Guys','Raising Cane''s','Cracker Barrel','Red Lobster']
      when 'Sodas'       then array['Coca-Cola','Pepsi','Dr Pepper','Mountain Dew','Root Beer','Sprite','Orange Crush','Cherry Coke','Ginger Ale','Barq''s Root Beer']
      when 'Songs'       then array['Bohemian Rhapsody','Hotel California','Stairway to Heaven','Imagine','Smells Like Teen Spirit','Johnny B. Goode','What''s Going On']
      when 'Books'       then array['To Kill a Mockingbird','1984','The Great Gatsby','Harry Potter','Lord of the Rings','Fahrenheit 451','Brave New World']
      else array[]::text[]
    end;
    n := 1;
    foreach v in array vals loop
      insert into category_items (category_id, item_text, sort_order) values (cat.id, v, n);
      n := n + 1;
    end loop;
  end loop;
end $$;
