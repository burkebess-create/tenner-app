-- Drop the deleted-duplicate-comments backup (2026-09-25)
--
-- Applied as: drop_deleted_duplicate_comments_backup
--
-- _deleted_duplicate_comments_20260921 held the 6 comments removed by
-- drop_double_submitted_comments on Sept 21. The cleanup is settled, so the
-- owner asked for it to go. This also retires the exemption added earlier the
-- same day in 2026-09-25-exempt-deleted-comment-backup.sql — with the table
-- gone the rename guard has nothing to flag, and an exemption naming a table
-- that no longer exists is just stale.
--
-- VERIFIED BEFORE DROPPING: for all 6 rows, the surviving copy is still
-- present in list_item_comments — matched on from_user_id, list_owner_id,
-- category, item_name AND the comment text. Nothing was lost by the original
-- de-duplication, and nothing is lost by dropping this.
--
-- What is discarded is the comment text of the DUPLICATE rows, which is
-- identical to the surviving copy in every case — that is what made them
-- duplicates. No unique content is destroyed.
--
-- Metadata kept as the record. Ids truncated and bodies deliberately not
-- transcribed: real users' comments do not belong in a migration file.
--
--   comment  author    category                       item                  len
--   57d90c41 35659501  Rom Coms                       You've Got Mail        17
--   8c72454a 438f289d  Dumb and Dummer Quotes         __list__               83
--   c6b8c91a cdf0b087  Candy Bars                     Baby Ruth               8
--   3e136609 7224482b  Things That Are Overrated      Working for the Man     1
--   ad3ed28f a4eb5397  Movies                         Pride and Prejudice     8
--   dae0499c a4eb5397  Best Purchases I've Ever Made  Engagement ring         4
--
-- VERIFIED AFTER: rename coverage is 10 updated / 1 exempt (feedback only) /
-- 0 uncovered, and a category rename as an admin still succeeds.

delete from public.category_rename_exempt_tables
 where table_name = '_deleted_duplicate_comments_20260921';

drop table if exists public._deleted_duplicate_comments_20260921;
