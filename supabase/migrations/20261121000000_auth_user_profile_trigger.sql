-- ============================================================================
-- Create a user profile for every new Supabase Auth user
-- ============================================================================
-- The baseline (20250129000000) defines public.handle_new_user() but, being a
-- dump of the public schema only, never attached it to auth.users. On a fresh
-- database (local Docker, a new shared GSC database) sign-up, invitation
-- acceptance and admin-created users therefore got no user_profiles row, and
-- every profile-based permission check failed for them.
--
-- Safe on databases that already have such a trigger (added by hand):
--   * the trigger is created only when no trigger on auth.users calls
--     handle_new_user() yet, and
--   * the function becomes idempotent (ON CONFLICT DO NOTHING), so even a
--     second, differently named trigger can't cause a duplicate-key failure.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  INSERT INTO public.user_profiles (id, email, name)
  VALUES (NEW.id, NEW.email, COALESCE(NULLIF(NEW.raw_user_meta_data->>'name', ''), NEW.email))
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.handle_new_user() IS
  'Creates the user_profiles row for a new auth.users record (idempotent). Attached by trigger on_auth_user_created.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'auth.users'::regclass
      AND NOT tgisinternal
      AND tgfoid = 'public.handle_new_user()'::regprocedure
  ) THEN
    CREATE TRIGGER on_auth_user_created
      AFTER INSERT ON auth.users
      FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
  END IF;
END $$;

-- Backfill users created while the trigger was missing (email is required on profiles)
INSERT INTO public.user_profiles (id, email, name)
SELECT u.id, u.email, COALESCE(NULLIF(u.raw_user_meta_data->>'name', ''), u.email)
FROM auth.users u
WHERE u.email IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.user_profiles p WHERE p.id = u.id)
ON CONFLICT (id) DO NOTHING;
