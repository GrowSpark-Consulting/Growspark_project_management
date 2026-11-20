-- ============================================================================
-- Users who appear in the audit log can be deleted again
-- ============================================================================
-- audit_log.actor_id references user_profiles ON DELETE SET NULL, but the
-- append-only trigger (20261122000200) refused every UPDATE, including the one that
-- SET NULL performs. So deleting any user who had ever done something audited
-- (status change, department change, override access) failed with
-- "Database error deleting user".
--
-- The trigger now lets exactly that change through: actor_id cleared while every other
-- column stays identical. The deleted person's id is kept in details.deleted_actor_id,
-- so the entry still says who acted. Any other UPDATE, and every DELETE, is still
-- refused.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.audit_log_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.actor_id IS NOT NULL AND NEW.actor_id IS NULL
     AND NEW.id = OLD.id
     AND NEW.action = OLD.action
     AND NEW.entity_type = OLD.entity_type
     AND NEW.entity_id IS NOT DISTINCT FROM OLD.entity_id
     AND NEW.project_id IS NOT DISTINCT FROM OLD.project_id
     AND NEW.details = OLD.details
     AND NEW.created_at = OLD.created_at
  THEN
    NEW.details := OLD.details || jsonb_build_object('deleted_actor_id', OLD.actor_id);
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'The audit log is append-only' USING ERRCODE = '42501';
END;
$$;
