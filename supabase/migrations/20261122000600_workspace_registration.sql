-- ============================================================================
-- Company / workspace registration (one company per installation)
-- ============================================================================
-- The first registration creates the company workspace and its manager
-- (POST /api/register). The workspace details live on the single app_settings row.
-- registered_at is set exactly once, by a conditional update, so two simultaneous
-- registrations can't both succeed.
-- onboarding: the manager's onboarding checklist state ({"skipped": ["step", ...]}).
-- ============================================================================

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS workspace_name    text,
  ADD COLUMN IF NOT EXISTS workspace_slug    text,
  ADD COLUMN IF NOT EXISTS company_phone     text,
  ADD COLUMN IF NOT EXISTS registered_at     timestamptz,
  ADD COLUMN IF NOT EXISTS registered_by     uuid,
  ADD COLUMN IF NOT EXISTS terms_version     text,
  ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS onboarding        jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_workspace_slug_format;
ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_workspace_slug_format
  CHECK (workspace_slug IS NULL OR workspace_slug ~ '^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])$');

ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_onboarding_object;
ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_onboarding_object
  CHECK (jsonb_typeof(onboarding) = 'object');
