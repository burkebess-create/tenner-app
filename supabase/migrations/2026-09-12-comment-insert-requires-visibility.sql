-- 2026-09-12 — You can comment on a list only if you can see the list
--
-- THE HOLE
-- The INSERT check required only that the author be themselves, not banned,
-- and that the owner had comments enabled. It asserted NO relationship to the
-- owner, so any account could post onto any user's list by calling the API
-- directly. Not reachable through the app — lists_select never shows a
-- stranger the list — but the anon key is public by design, so a crafted
-- request was all it took. item_name was not validated either, so the comment
-- did not even have to land on a real item.
--
-- Worse, posting then granted READ: _is_thread_participant counts the author
-- as a participant, so an outsider could open a thread on someone's list and
-- then read every reply the owner and their friends left on it.
--
-- THE RULE
-- Writing now uses the same boundary as reading: _can_view_list, which defers
-- to lists_select (owner, friends on a public list, accepted group co-members,
-- both sides of a share invite). This also closes the post-then-read path,
-- since the post never lands to make them a participant.
--
-- The owner's allow_comments_on_my_lists toggle is preserved on top:
-- visibility is necessary, not sufficient.
--
-- Verified under `set local role authenticated`:
--   friend commenting on a visible list       ALLOWED (no regression)
--   owner commenting on their own list        ALLOWED (no regression)
--   stranger, real item                       BLOCKED 42501
--   stranger, invented item_name              BLOCKED 42501  (the old bypass)
--   stranger reading the thread afterwards    0 rows
--   group co-member who is NOT a friend       ALLOWED (no regression)
--
-- The last case had no example in live data — every group member happened to
-- also be a friend — so it was proven against a synthetic group built and torn
-- down inside the test. Without it, this migration could have silently broken
-- commenting for group-only members the first time such a pair existed.

drop policy if exists "Insert comment if owner allows" on public.list_item_comments;
create policy "Insert comment if owner allows" on public.list_item_comments
  for insert to authenticated
  with check (
    auth.uid() = from_user_id
    and public.actor_not_banned()
    and (
      list_owner_id = auth.uid()
      or (
        public._can_view_list(list_owner_id, category)
        and exists (
          select 1 from public.profiles p
          where p.id = list_item_comments.list_owner_id
            and coalesce(p.allow_comments_on_my_lists, true) = true
        )
      )
    )
  );
