-- ============================================================================
-- Project Management three-portal revision — Migration 3/3: collaboration
-- Comments (tasks + project updates, one reply level, mentions), project files
-- (+ private storage bucket), deliverable files, task timer on clock sessions.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Comments
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.comments (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  task_id uuid REFERENCES public.tasks(id) ON DELETE CASCADE,
  update_id uuid REFERENCES public.project_updates(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES public.comments(id) ON DELETE CASCADE,
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 5000),
  mentions uuid[] NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT comments_one_target CHECK (num_nonnulls(task_id, update_id) = 1)
);
CREATE INDEX IF NOT EXISTS idx_comments_task ON public.comments (task_id, created_at) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_comments_update ON public.comments (update_id, created_at) WHERE update_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_comments_project ON public.comments (project_id);
CREATE INDEX IF NOT EXISTS idx_comments_mentions ON public.comments USING gin (mentions);

CREATE OR REPLACE FUNCTION public.prepare_comment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE parent_row public.comments%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.updated_at := now();
    NEW.project_id := OLD.project_id; NEW.task_id := OLD.task_id; NEW.update_id := OLD.update_id; NEW.parent_id := OLD.parent_id;
    RETURN NEW;
  END IF;
  IF NEW.task_id IS NOT NULL THEN
    SELECT project_id INTO NEW.project_id FROM public.tasks WHERE id = NEW.task_id;
  ELSE
    SELECT project_id INTO NEW.project_id FROM public.project_updates WHERE id = NEW.update_id;
  END IF;
  IF NEW.project_id IS NULL THEN RAISE EXCEPTION 'Comment target not found' USING ERRCODE = '23503'; END IF;
  IF NEW.parent_id IS NOT NULL THEN
    SELECT * INTO parent_row FROM public.comments WHERE id = NEW.parent_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Parent comment not found' USING ERRCODE = '23503'; END IF;
    IF parent_row.parent_id IS NOT NULL THEN RAISE EXCEPTION 'Replies can only be one level deep' USING ERRCODE = '23514'; END IF;
    IF parent_row.task_id IS DISTINCT FROM NEW.task_id OR parent_row.update_id IS DISTINCT FROM NEW.update_id THEN
      RAISE EXCEPTION 'Reply must belong to the same thread' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS prepare_comment ON public.comments;
CREATE TRIGGER prepare_comment BEFORE INSERT OR UPDATE ON public.comments
  FOR EACH ROW EXECUTE FUNCTION public.prepare_comment();

ALTER TABLE public.comments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cm_select ON public.comments;
DROP POLICY IF EXISTS cm_insert ON public.comments;
DROP POLICY IF EXISTS cm_update ON public.comments;
DROP POLICY IF EXISTS cm_delete ON public.comments;
CREATE POLICY cm_select ON public.comments FOR SELECT USING (public.user_can_view_project(project_id));
CREATE POLICY cm_insert ON public.comments FOR INSERT WITH CHECK (
  created_by = auth.uid() AND public.user_can_contribute(
    COALESCE(public.task_project(task_id), (SELECT pu.project_id FROM public.project_updates pu WHERE pu.id = update_id))));
CREATE POLICY cm_update ON public.comments FOR UPDATE USING (created_by = auth.uid());
CREATE POLICY cm_delete ON public.comments FOR DELETE USING (created_by = auth.uid() OR public.user_can_manage_project(project_id));

-- ----------------------------------------------------------------------------
-- 2. Project files (documents, task attachments, deliverable files, client uploads)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.project_files (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
  storage_path text NOT NULL UNIQUE,
  mime_type text,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  client_visible boolean NOT NULL DEFAULT false,
  uploaded_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_files_project ON public.project_files (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_files_task ON public.project_files (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_project_files_shared ON public.project_files (project_id) WHERE client_visible;

ALTER TABLE public.project_files ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pf_select ON public.project_files;
DROP POLICY IF EXISTS pf_insert ON public.project_files;
DROP POLICY IF EXISTS pf_update ON public.project_files;
DROP POLICY IF EXISTS pf_delete ON public.project_files;
CREATE POLICY pf_select ON public.project_files FOR SELECT USING (public.user_can_view_project(project_id));
CREATE POLICY pf_insert ON public.project_files FOR INSERT WITH CHECK (uploaded_by = auth.uid() AND public.user_can_contribute(project_id));
CREATE POLICY pf_update ON public.project_files FOR UPDATE USING (uploaded_by = auth.uid() OR public.user_can_manage_project(project_id));
CREATE POLICY pf_delete ON public.project_files FOR DELETE USING (uploaded_by = auth.uid() OR public.user_can_manage_project(project_id));

ALTER TABLE public.deliverables
  ADD COLUMN IF NOT EXISTS file_id uuid REFERENCES public.project_files(id) ON DELETE SET NULL;

-- Private bucket; only the server (service role) reads/writes objects.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('project-files', 'project-files', false, 10485760)
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 3. Task timer: link a clock session to the task being worked on
-- ----------------------------------------------------------------------------
ALTER TABLE public.clock_sessions
  ADD COLUMN IF NOT EXISTS task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL;
