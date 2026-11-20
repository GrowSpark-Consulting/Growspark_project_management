-- ============================================================================
-- Audit log (SEC-12: superadmin / override access was not recorded)
-- ============================================================================
-- Append-only record of privileged actions. Written only by the server (service role);
-- readable only by superadmins. Rows can't be changed or deleted, so the log can be trusted.
-- project_id has no foreign key on purpose: the log must outlive the project.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   uuid,
  project_id  uuid,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created ON public.audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor   ON public.audit_log (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_project ON public.audit_log (project_id, created_at DESC);

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_log_superadmin_read ON public.audit_log;
CREATE POLICY audit_log_superadmin_read ON public.audit_log
  FOR SELECT USING (public.user_is_superadmin());
-- No INSERT / UPDATE / DELETE policies: only the service role (which bypasses RLS) can write.

REVOKE ALL ON public.audit_log FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.audit_log FROM authenticated;

CREATE OR REPLACE FUNCTION public.audit_log_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'The audit log is append-only' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS audit_log_no_change ON public.audit_log;
CREATE TRIGGER audit_log_no_change
  BEFORE UPDATE OR DELETE ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_append_only();
