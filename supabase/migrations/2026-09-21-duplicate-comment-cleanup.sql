-- Double-posted comments: guard + cleanup (2026-09-21)
--
-- Applied as migration drop_double_submitted_comments, plus a one-off data
-- cleanup recorded here.
--
-- CAUSE: submitItemComment() awaited a moderation round-trip to an edge
-- function BEFORE clearing the textarea or disabling the Post button. For the
-- few hundred milliseconds that call takes, the button stayed live and the
-- field still held the text, so a second tap — or a second Enter, which the
-- textarea also binds — read the same value and inserted it again. Six
-- comments were posted twice this way, 0.3s to 3.1s apart, from 2026-08-14
-- onward.
--
-- The client now holds a re-entrancy flag, disables the button, and clears
-- the field up front. This trigger is the second layer, because the client is
-- untrusted and this went unnoticed for over a month.
--
-- It returns NULL rather than raising: a double submit should look like it
-- worked, not like an error aimed at someone who did nothing wrong. The
-- window is deliberately short so deliberately repeating yourself later still
-- works.
--
-- VERIFIED (inside a deliberately aborted transaction):
--   identical comment within the window      DROPPED
--   a different comment                      kept
--   the same text after the window           allowed
--   a different author, same text            allowed

create or replace function public.drop_double_posted_comment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1 from public.list_item_comments c
    where c.from_user_id  = new.from_user_id
      and c.list_owner_id is not distinct from new.list_owner_id
      and c.category      is not distinct from new.category
      and c.item_name     is not distinct from new.item_name
      and c.comment       = new.comment
      and c.created_at    > now() - interval '15 seconds'
  ) then
    return null;   -- cancel the insert, no error
  end if;
  return new;
end $$;

drop trigger if exists trg_drop_double_posted_comment on public.list_item_comments;
create trigger trg_drop_double_posted_comment
  before insert on public.list_item_comments
  for each row execute function public.drop_double_posted_comment();

-- ── One-off cleanup of the six existing duplicates ─────────────────────
--
-- Removed the LATER copy of each pair, keeping the original. Done by explicit
-- id, never by pattern. Confirmed first that nothing has a foreign key to
-- list_item_comments.id.
--
-- REVERSIBLE: full rows were copied to _deleted_duplicate_comments_20260921
-- (6 rows) before deletion. RLS is enabled on that table with no policy, so
-- only the service role can read it. Drop it once you are satisfied.
--
-- Four queued notifications pointed at the removed copies. Three had already
-- been delivered (sent_at set) and were left as history. One was still
-- UNSENT — the Candy Bars "Really?!" duplicate — and would otherwise have
-- notified someone about a comment that no longer exists; it was removed too,
-- backed up to _deleted_dup_comment_notifs_20260921 (1 row).
--
--   removed:  Best Purchases I've Ever Made / Engagement ring  "7th?"
--             Candy Bars / Baby Ruth                           "Really?!"
--             Dumb and Dummer Quotes / __list__                "I couldn't name one quote…"
--             Movies / Pride and Prejudice                     "Correct!"
--             Rom Coms / You've Got Mail                       "I like this movie"
--             Things That Are Overrated / Working for the Man  "💯"
--
-- AFTER: 0 duplicate groups remain, 54 comments total, and each of the six
-- threads still has exactly one copy of its comment — verified row by row.
--
-- The statements as run (ids elided here; see the backup table for the exact
-- rows):
--   insert into _deleted_duplicate_comments_20260921 select * from
--     list_item_comments where id in (<the six later copies>);
--   delete from list_item_comments where id in (<the six later copies>);
--   delete from notification_queue
--     where id = '6fff55f0-…' and sent_at is null;
