-- ============================================================================
-- Suspend users (temporary deactivation with a reason)
-- ============================================================================
-- A suspended user is inactive (is_active = false, sign-in banned) until suspended_until;
-- the server lifts an expired suspension automatically on their next request. Without an
-- end date a suspension lasts until someone reactivates the account.
-- The new columns are privileged: users can't change them on their own profile.
-- ============================================================================

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS suspended_until   timestamptz,
  ADD COLUMN IF NOT EXISTS suspension_reason text;

CREATE OR REPLACE FUNCTION public.protect_profile_privileged_columns() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- service role / direct SQL (no JWT user) and superadmins may change anything
  IF auth.uid() IS NULL OR COALESCE(auth.role(), '') = 'service_role' OR public.user_is_superadmin() THEN
    RETURN NEW;
  END IF;
  IF NEW.is_superadmin     IS DISTINCT FROM OLD.is_superadmin
  OR NEW.is_client         IS DISTINCT FROM OLD.is_client
  OR NEW.client_account_id IS DISTINCT FROM OLD.client_account_id
  OR NEW.email             IS DISTINCT FROM OLD.email
  OR NEW.is_active         IS DISTINCT FROM OLD.is_active
  OR NEW.deactivated_at    IS DISTINCT FROM OLD.deactivated_at
  OR NEW.suspended_until   IS DISTINCT FROM OLD.suspended_until
  OR NEW.suspension_reason IS DISTINCT FROM OLD.suspension_reason THEN
    RAISE EXCEPTION 'Not allowed to change privileged profile fields' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
