-- Performance advisor cleanup — batch 1
--   • Add 8 missing FK indexes
--   • Lock down search_path on 5 SECURITY DEFINER functions
CREATE INDEX IF NOT EXISTS feedback_user_id_idx ON public.feedback(user_id);
CREATE INDEX IF NOT EXISTS friend_views_friend_id_idx ON public.friend_views(friend_id);
CREATE INDEX IF NOT EXISTS friendships_addressee_id_idx ON public.friendships(addressee_id);
CREATE INDEX IF NOT EXISTS group_lists_shared_by_idx ON public.group_lists(shared_by);
CREATE INDEX IF NOT EXISTS groups_created_by_idx ON public.groups(created_by);
CREATE INDEX IF NOT EXISTS list_item_comments_from_user_id_idx ON public.list_item_comments(from_user_id);
CREATE INDEX IF NOT EXISTS list_item_comments_list_owner_id_idx ON public.list_item_comments(list_owner_id);
CREATE INDEX IF NOT EXISTS weekly_lists_created_by_idx ON public.weekly_lists(created_by);

ALTER FUNCTION public.is_member_of_group SET search_path = public, pg_temp;
ALTER FUNCTION public.are_friends SET search_path = public, pg_temp;
ALTER FUNCTION public.is_group_member SET search_path = public, pg_temp;
ALTER FUNCTION public.check_handle_not_retired SET search_path = public, pg_temp;
ALTER FUNCTION public.retire_old_handle SET search_path = public, pg_temp;
