-- ============================================================================
-- form_templates: the columns the application code reads (defect D-5)
-- ============================================================================
-- The live table stores the form definition in "schema" and has no "is_active".
-- Application code (lib/form-service.ts, the workflow progress button and the project
-- page) reads "fields" and "is_active", so form templates could not be listed, created
-- or archived, and embedded selects of form_templates(fields) failed.
--
--   is_active  real column, default true (soft delete / archive instead of deleting rows)
--   fields     READ-ONLY column derived from "schema" (the stored array, or schema->'fields'
--              when the definition is stored as an object); writers keep using "schema"
-- No data is changed or moved.
-- ============================================================================

ALTER TABLE public.form_templates
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

ALTER TABLE public.form_templates
  ADD COLUMN IF NOT EXISTS fields jsonb GENERATED ALWAYS AS (
    CASE jsonb_typeof(schema)
      WHEN 'array'  THEN schema
      WHEN 'object' THEN COALESCE(schema -> 'fields', '[]'::jsonb)
      ELSE '[]'::jsonb
    END
  ) STORED;
