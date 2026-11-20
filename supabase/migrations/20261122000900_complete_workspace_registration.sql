-- ============================================================================
-- Finish a company registration in ONE transaction
-- ============================================================================
-- POST /api/register runs in three stages:
--   1. claim the installation (conditional update of app_settings.registered_at),
--   2. create the manager's sign-in account (Supabase Auth admin API),
--   3. this function: the manager's profile (superadmin), the Superadmin role and
--      app_settings.registered_by, written together or not at all.
-- Before this, stage 3 was three separate writes and a failure of the last one
-- (registered_by) was not checked, so a registration could end half-finished.
-- If this function fails, the route deletes the account from stage 2 and releases
-- the claim from stage 1, so nothing is left behind.
--
-- Callable by the service role only (the registration route). Raises 55000
-- (object_not_in_prerequisite_state) when the installation is not in the middle of
-- a registration or already has other users.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.complete_workspace_registration(
  p_user_id uuid,
  p_email   text,
  p_name    text,
  p_phone   text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role uuid;
BEGIN
  -- The claim must be held and not finished yet; the row lock serialises two finishers.
  PERFORM 1 FROM app_settings
   WHERE id = true AND registered_at IS NOT NULL AND registered_by IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No company registration is in progress' USING ERRCODE = '55000';
  END IF;

  -- Only the new manager may exist (the auth trigger has just created their profile).
  IF EXISTS (SELECT 1 FROM user_profiles WHERE id <> p_user_id) THEN
    RAISE EXCEPTION 'This installation already has users' USING ERRCODE = '55000';
  END IF;

  SELECT id INTO v_role FROM roles WHERE name = 'Superadmin' AND is_system_role LIMIT 1;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'The Superadmin role is missing' USING ERRCODE = '55000';
  END IF;

  INSERT INTO user_profiles (id, email, name, phone, is_superadmin, is_active, has_completed_onboarding)
  VALUES (p_user_id, p_email, p_name, p_phone, true, true, true)
  ON CONFLICT (id) DO UPDATE
     SET email = EXCLUDED.email,
         name = EXCLUDED.name,
         phone = EXCLUDED.phone,
         is_superadmin = true,
         is_active = true,
         has_completed_onboarding = true;

  INSERT INTO user_roles (user_id, role_id, assigned_by)
  VALUES (p_user_id, v_role, p_user_id)
  ON CONFLICT (user_id, role_id) DO NOTHING;

  UPDATE app_settings SET registered_by = p_user_id, updated_at = now() WHERE id = true;
END
$$;

REVOKE ALL ON FUNCTION public.complete_workspace_registration(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_workspace_registration(uuid, text, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_workspace_registration(uuid, text, text, text) TO service_role;
