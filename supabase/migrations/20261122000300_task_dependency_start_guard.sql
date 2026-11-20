-- ============================================================================
-- A task cannot be started while tasks it depends on are not done
-- ============================================================================
-- Dependencies were only recorded: nothing stopped someone starting a task whose
-- predecessors were unfinished ("Project scheduling" gap in the feature checklist).
-- Enforced in the database so every path (API, direct Supabase call) behaves the same.
--
-- Project managers and superadmins may start a task early (they own the schedule); the
-- server (service role) is not restricted. Everyone else gets "Waiting for: <task names>".
-- ============================================================================

CREATE OR REPLACE FUNCTION public.enforce_dependencies_before_start()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_waiting text;
BEGIN
  IF NEW.status IS DISTINCT FROM 'in_progress' OR OLD.status IS NOT DISTINCT FROM 'in_progress' THEN
    RETURN NEW;
  END IF;
  IF public.caller_is_trusted() OR public.user_is_superadmin() OR public.user_can_manage_project(NEW.project_id) THEN
    RETURN NEW;
  END IF;

  SELECT string_agg(p.name, ', ' ORDER BY p.name) INTO v_waiting
  FROM public.task_dependencies td
  JOIN public.tasks p ON p.id = td.depends_on_task_id
  WHERE td.task_id = NEW.id AND p.status IS DISTINCT FROM 'done';

  IF v_waiting IS NOT NULL THEN
    RAISE EXCEPTION 'Waiting for: %', v_waiting USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_dependencies_before_start ON public.tasks;
CREATE TRIGGER enforce_dependencies_before_start
  BEFORE UPDATE OF status ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.enforce_dependencies_before_start();
