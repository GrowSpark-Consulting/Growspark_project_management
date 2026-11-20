-- ============================================================================
-- Employee invitations: projects, phone, revoke tracking
-- ============================================================================
-- project_ids  projects the employee joins when they accept (checked when the invitation is
--              created: the inviter must be able to manage each project)
-- phone        the number the WhatsApp link was prepared for
-- revoked_at / revoked_by  who cancelled a pending invitation, and when
-- ============================================================================

ALTER TABLE public.user_invitations
  ADD COLUMN IF NOT EXISTS project_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS phone       text,
  ADD COLUMN IF NOT EXISTS revoked_at  timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_by  uuid;

ALTER TABLE public.user_invitations DROP CONSTRAINT IF EXISTS user_invitations_project_ids_max;
ALTER TABLE public.user_invitations ADD CONSTRAINT user_invitations_project_ids_max
  CHECK (cardinality(project_ids) <= 50);
