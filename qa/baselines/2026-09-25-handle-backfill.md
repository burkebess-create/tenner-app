# Handle backfill baseline — captured 2026-09-25 03:09:48 UTC

Taken immediately after 6120ffe (profiles .upsert -> .update) deployed.
Before the fix, every pass through onboarding collected a handle and
discarded it, so this number had been RISING: 9 on Sept 23, 13 now.

Real accounts only (is_internal = false, is_system = false).

    no_handle  13
    no_name     2

The 13 with no handle:

    Anna Wiser          a51a31f9
    Cleola Bess         2782adb1
    Heidi Jacobs        75f0c68b
    Jenna Dilworth      83e80b86
    Julia Bramall       147d75c6
    Keri Perry          6ae6b4da
    Kolton Baldwin      4333b4bf
    Lisa Mercer         0aaa90f0
    Mallory Jones       b654d4ad
    Natalie Nabrotzky   40e6bcac
    spencer jacobs      6177bfcc

(11 names listed; the other 2 of the 13 are the accounts with no
display_name either, so they aggregate to NULL in the name list.)

## What "cleared" means

A handle only lands when the user opens the app and completes the
handle step, which is now gated on the write actually succeeding. So
the count falls as people log in, not on a schedule. Anyone who has
not opened Tenner since the fix will still be on this list — that is
expected and is not a regression.

## What to check

    select count(*) from public.profiles
     where coalesce(nullif(btrim(handle),''),'') = ''
       and coalesce(is_internal,false)=false
       and coalesce(is_system,false)=false;

And cross-reference sign-ins since 2026-09-25 03:09 UTC: a user who
signed in and STILL has no handle means the fix did not take, which is
the failure worth escalating.
