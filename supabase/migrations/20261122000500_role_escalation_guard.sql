-- ============================================================================
-- Role escalation guard (found 2026-11-19, local test as the Executive user)
-- ============================================================================
-- Before this migration:
--   * anyone with manage_user_roles (Executive, Project Director) could insert ANY
--     user_roles row, for anyone including themselves, including the Superadmin role;
--   * anyone with manage_departments could edit the permissions of ANY role,
--     including their own.
--
-- Rules now enforced for every caller except a superadmin and the server (service role):
--   user_roles
--     1. System roles (Superadmin, Client, No Assigned Role) are assigned/removed only by a superadmin.
--     2. Nobody changes their own role assignments.
--     3. A superadmin's role assignments are changed only by a superadmin.
--     4. Only roles whose granted permissions the caller holds can be assigned or removed
--        (no handing out more power than you have).
--   roles
--     5. System roles are created, edited and deleted only by a superadmin.
--     6. A role can't be given a permission the caller doesn't hold.
-- The API applies the same rules (lib/role-guard.ts) so users get clear messages.
-- ============================================================================

-- True when the caller holds every permission that `perms` grants (value true).
CREATE OR REPLACE FUNCTION public.caller_holds_permissions(perms jsonb)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM jsonb_each(COALESCE(perms, '{}'::jsonb)) AS p(key, value)
    WHERE p.value = 'true'::jsonb AND NOT public.user_has_permission(p.key)
  );
$$;

REVOKE ALL ON FUNCTION public.caller_holds_permissions(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.caller_holds_permissions(jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.enforce_role_assignment_rules()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_target uuid := COALESCE(NEW.user_id, OLD.user_id);
  v_role   record;
  v_role_id uuid;
BEGIN
  IF public.caller_is_trusted() OR public.user_is_superadmin() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF v_target = auth.uid() OR (TG_OP = 'UPDATE' AND OLD.user_id = auth.uid()) THEN
    RAISE EXCEPTION 'You cannot change your own roles' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (SELECT 1 FROM public.user_profiles WHERE id = v_target AND is_superadmin) THEN
    RAISE EXCEPTION 'Only a superadmin can change a superadmin''s roles' USING ERRCODE = '42501';
  END IF;

  FOREACH v_role_id IN ARRAY ARRAY[
    CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN NEW.role_id END,
    CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD.role_id END
  ] LOOP
    CONTINUE WHEN v_role_id IS NULL;
    SELECT name, is_system_role, permissions INTO v_role FROM public.roles WHERE id = v_role_id;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF v_role.is_system_role THEN
      RAISE EXCEPTION 'Only a superadmin can assign or remove the % role', v_role.name USING ERRCODE = '42501';
    END IF;
    IF NOT public.caller_holds_permissions(v_role.permissions) THEN
      RAISE EXCEPTION 'You can only assign or remove roles whose permissions you hold yourself (%)', v_role.name USING ERRCODE = '42501';
    END IF;
  END LOOP;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS enforce_role_assignment_rules ON public.user_roles;
CREATE TRIGGER enforce_role_assignment_rules
  BEFORE INSERT OR UPDATE OR DELETE ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_role_assignment_rules();

CREATE OR REPLACE FUNCTION public.enforce_role_definition_rules()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF public.caller_is_trusted() OR public.user_is_superadmin() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF (TG_OP IN ('UPDATE', 'DELETE') AND OLD.is_system_role) OR (TG_OP IN ('INSERT', 'UPDATE') AND NEW.is_system_role) THEN
    RAISE EXCEPTION 'Only a superadmin can change system roles' USING ERRCODE = '42501';
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') AND NOT public.caller_holds_permissions(NEW.permissions) THEN
    RAISE EXCEPTION 'You can''t give a role a permission you don''t hold yourself' USING ERRCODE = '42501';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS enforce_role_definition_rules ON public.roles;
CREATE TRIGGER enforce_role_definition_rules
  BEFORE INSERT OR UPDATE OR DELETE ON public.roles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_role_definition_rules();
