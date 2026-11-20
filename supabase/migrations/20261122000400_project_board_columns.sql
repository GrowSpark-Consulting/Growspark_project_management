-- ============================================================================
-- Customizable task board columns per project
-- ============================================================================
-- The six task statuses are a workflow enforced by triggers, so columns can't add statuses.
-- A project manager can instead rename, reorder and hide the six status columns and set a
-- work-in-progress limit per column. NULL = the default board.
-- Format: [{"status":"todo","label":"Backlog","hidden":false,"wip_limit":null}, ...]
-- Validated by the API (PUT /api/projects/[id]/board); the check keeps the shape sane.
-- ============================================================================

ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS board_columns jsonb;

ALTER TABLE public.projects DROP CONSTRAINT IF EXISTS projects_board_columns_shape;
ALTER TABLE public.projects ADD CONSTRAINT projects_board_columns_shape
  CHECK (board_columns IS NULL OR (jsonb_typeof(board_columns) = 'array' AND jsonb_array_length(board_columns) <= 6));
