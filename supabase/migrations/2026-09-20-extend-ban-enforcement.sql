-- Extend actor_not_banned() to every remaining user-write policy
-- (2026-09-20)
--
-- Applied as two migrations:
--   extend_ban_check_to_reactions_invites_members_feedback
--   extend_ban_check_to_remaining_write_policies
--
-- BEFORE: actor_not_banned() gated 6 policies across 4 tables — friendships
-- INSERT, groups INSERT, lists INSERT/UPDATE, list_item_comments
-- INSERT/UPDATE. A suspended user could still insert list_reactions and
-- list_share_invites (i.e. keep pushing content at the people they were
-- suspended over), join groups, file feedback, accept a pending friend
-- request, and rename or re-photograph any group they admin.
--
-- The client-side checkIfBanned() does not close this. It fails open on a
-- read error, and the frontend is untrusted regardless.
--
-- AFTER: 16 of 17 write policies on those tables are gated. The one that
-- isn't is feedback_admin_update, which is admin-only and correct as-is.
--
-- Each ALTER only ANDs the ban check onto the policy's existing predicate;
-- no other condition changed. The check goes on WITH CHECK (the write side)
-- rather than USING, so a suspended user can still READ their own rows —
-- important so the app can render the suspended screen rather than an
-- inexplicably empty one.
--
-- list_share_invites_update and friendships_update had WITH CHECK = null,
-- which makes Postgres reuse USING for the write check. Both now spell the
-- write check out explicitly; that is what allows the ban condition to apply
-- to writes only.
--
-- APPEALS ARE UNAFFECTED: showSuspendedScreen() routes appeals to
-- contact@mytenner.com over email, not through in-app feedback.
--
-- VERIFIED (each test ran inside a transaction deliberately aborted with
-- RAISE EXCEPTION, so nothing persisted; residue re-checked afterwards and
-- was zero, including is_banned back to 0 users):
--
--   as a BANNED user:      list_reactions insert     BLOCKED
--                          list_share_invites insert BLOCKED
--                          feedback insert           BLOCKED
--                          group_members insert      BLOCKED
--                          friendships update        BLOCKED
--                          groups update             BLOCKED
--
--   as a NOT-banned user:  all of the above          STILL WORK
--
-- Definitions live in the Supabase migration history; reproduced here for
-- the repo record.

alter policy list_reactions_insert on public.list_reactions
  with check (((select auth.uid()) = from_user_id) and public.actor_not_banned());

alter policy list_reactions_update on public.list_reactions
  using (((select auth.uid()) = from_user_id))
  with check (((select auth.uid()) = from_user_id) and public.actor_not_banned());

alter policy list_share_invites_insert on public.list_share_invites
  with check ((from_user_id = (select auth.uid())) and public.actor_not_banned());

alter policy list_share_invites_update on public.list_share_invites
  using ((from_user_id = (select auth.uid())) or (to_user_id = (select auth.uid())))
  with check (((from_user_id = (select auth.uid())) or (to_user_id = (select auth.uid())))
              and public.actor_not_banned());

alter policy group_members_insert on public.group_members
  with check (((user_id = (select auth.uid()))
               or public.is_group_creator(group_id)
               or public.is_group_admin(group_id))
              and public.actor_not_banned());

alter policy group_members_update on public.group_members
  using ((user_id = (select auth.uid()))
         or public.is_group_admin(group_id)
         or public.is_group_creator(group_id))
  with check (((user_id = (select auth.uid()))
               or public.is_group_admin(group_id)
               or public.is_group_creator(group_id))
              and public.actor_not_banned());

alter policy feedback_insert on public.feedback
  with check ((((select auth.uid()) = user_id)
               or exists (select 1 from public.admins where admins.user_id = (select auth.uid())))
              and public.actor_not_banned());

alter policy feedback_owner_answer on public.feedback
  using (user_id = (select auth.uid()))
  with check ((user_id = (select auth.uid()))
              and (status = any (array['new'::text, 'in_progress'::text, 'awaiting_user'::text]))
              and public.actor_not_banned());

alter policy friendships_update on public.friendships
  using ((requester_id = (select auth.uid())) or (addressee_id = (select auth.uid())))
  with check (((requester_id = (select auth.uid())) or (addressee_id = (select auth.uid())))
              and public.actor_not_banned());

alter policy groups_update on public.groups
  using (public.is_group_admin(id) or (created_by = (select auth.uid())))
  with check ((public.is_group_admin(id) or (created_by = (select auth.uid())))
              and public.actor_not_banned());

-- NOT GATED, deliberately: feedback_replies_insert. A suspended user can
-- still reply inside an existing feedback thread of their own. That is the
-- one in-app channel where they can answer a question you asked them about
-- their own report, and it cannot be used to reach anyone but an admin.
-- Gate it too if you would rather all appeal traffic go through email.
