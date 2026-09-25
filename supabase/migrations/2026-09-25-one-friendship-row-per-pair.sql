-- One friendship row per PAIR, not per direction (2026-09-25)
--
-- Applied as: one_friendship_row_per_pair
--
-- friendships_requester_id_addressee_id_key is UNIQUE (requester_id,
-- addressee_id) — DIRECTIONAL. A->B and B->A are two legal rows, so when two
-- people added each other the database stored both and the app drew the same
-- person twice: "Alyssa / ACCEPTED" listed twice, and Keri Perry showing as
-- PENDING·RECEIVED and PENDING·SENT simultaneously.
--
-- The timestamps prove a race, not corruption:
--   Natalie / Alyssa      2 seconds apart
--   Natalie / Keri Perry  11 seconds
--   Teresa Bess / Ben     18 seconds
--   Pyper / Heidi Jacobs  2 minutes
--   Pyper / Riley         1.5 hours
--
-- insertFriendship() did a bare INSERT whose only guard was the caller
-- checking the LOCAL myFriends cache, which cannot know about a request the
-- other person sent seconds ago. The client now checks both directions and
-- accepts their pending request instead of adding a mirror row — but a
-- client-side check can never close a race, which is what this index is for.
--
-- Dedupe rule: keep an accepted row if the pair has one, else the earliest.
--   Pyper / Riley          accepted + accepted -> kept the first
--   Pyper / Heidi Jacobs   accepted + accepted -> kept the first
--   Natalie / Alyssa       accepted + accepted -> kept the first
--   Teresa Bess / Ben      pending + accepted  -> kept the ACCEPTED
--   Natalie / Keri Perry   pending + pending   -> kept the earliest pending
--
-- The last is deliberately NOT auto-accepted. Both did send a request, so
-- calling it mutual consent is arguable — but inventing an accepted
-- friendship between two real people is not a call to make in a migration.
-- One pending row survives, Keri sees a normal received request, and she
-- accepts it or she does not.
--
-- No relationship was lost: every deleted row duplicated a pair that still
-- has a row, or was a pending superseded by an accepted.
--
-- VERIFIED after applying: duplicate pairs 5 -> 0, 160 rows remain (122
-- accepted, 38 pending), and a reciprocal insert by the other party now
-- raises 23505 instead of being stored.
--
-- NOTE: accepting a request UPDATEs the existing row (status = 'accepted'),
-- it does not insert, so this index does not interfere with the accept flow.

with ranked as (
  select f.id,
         row_number() over (
           partition by least(f.requester_id, f.addressee_id),
                        greatest(f.requester_id, f.addressee_id)
           order by (f.status = 'accepted') desc, f.created_at
         ) as rn
  from public.friendships f
)
delete from public.friendships
 where id in (select id from ranked where rn > 1);

create unique index if not exists friendships_unique_pair
  on public.friendships (least(requester_id, addressee_id),
                         greatest(requester_id, addressee_id));

-- ── Addendum (2026-09-25): the mutual-pending pair was accepted ───────
--
-- The migration above deliberately left Natalie Nabrotzky / Keri Perry as a
-- single pending row rather than deciding on their behalf. Asked, and the
-- owner said to accept it — both of them had sent a request 11 seconds
-- apart, which is consent in both directions.
--
-- Scoped to that one row by id, and guarded on status still being 'pending'
-- so re-running cannot revive a friendship either of them later removed.
--
-- Checked first that friendships carries NO triggers, so this sends no email
-- and no push; notification fan-out in this app is client-driven.
--
-- After: duplicate pairs 0, accepted 122 -> 123, pending 38 -> 37.

update public.friendships
   set status = 'accepted'
 where id = 'ecbd8914-8ffb-4531-958d-1c11f1fe4441'
   and status = 'pending';
