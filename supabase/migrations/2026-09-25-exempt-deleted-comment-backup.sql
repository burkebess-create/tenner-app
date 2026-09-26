-- Stop a deleted-rows backup from blocking category renames (2026-09-25)
--
-- Applied as: exempt_deleted_comment_backup_from_rename_guard
--
-- _deleted_duplicate_comments_20260921 is the snapshot taken before
-- drop_double_submitted_comments removed 6 comments that had been posted
-- twice. It carries a `category` column, so category_rename_coverage_guard
-- counted it as a table storing list categories and refused EVERY rename
-- until it was accounted for. The admin Categories screen had been showing
-- "1 table would be missed by a rename" ever since.
--
-- It is EXEMPT rather than added to rename_category_everywhere(). The table
-- records which rows were deleted and what they said AT THE TIME. Rewriting
-- its category on a later rename would falsify that record — the entire
-- value of keeping it is that it does not change. The guard was right to
-- stop and ask; the answer is "never update this one", not "update it too".
--
-- VERIFIED, all inside deliberately aborted transactions:
--   coverage after the exemption   10 tables updated on rename, 2 exempt,
--                                  0 uncovered
--   rename as an admin             OK, and propagated to 7 lists
--   same rename with the exemption
--     removed again                BLOCKED — "_deleted_duplicate_comments_
--                                  20260921 stores a list category but is
--                                  not updated here"
--
-- So the banner was real, renames genuinely were blocked, and this is what
-- unblocked them.
--
-- NOTE for later: dropping the backup table is safe once the cleanup is
-- considered settled, and removes it from this list too. It holds 6 rows of
-- real user comments, so that is the owner's call, not a migration's.

insert into public.category_rename_exempt_tables (table_name, reason)
values ('_deleted_duplicate_comments_20260921',
        'Point-in-time backup of rows deleted 2026-09-21. Records what those '
        'rows said when they were removed; rewriting it on a rename would '
        'falsify the record. Safe to DROP once the cleanup is considered '
        'settled, which also removes it from this list.')
on conflict (table_name) do nothing;
