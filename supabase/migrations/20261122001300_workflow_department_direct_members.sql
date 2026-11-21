-- ============================================================================
-- Workflow department steps also notify people added to the department directly
-- ============================================================================
-- Since 20261122001100 a person is in a department through a role in it OR
-- directly (department_members). The step notification still counted roles
-- only, so a direct member was not told when a department step reached them.
-- Same function as in 20261122000000; the only change is the department_members
-- branch in the recipients of an internal step. The trigger is unchanged.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.notify_workflow_step_active()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_inst        record;
  v_node        record;
  v_project     record;
  v_is_client   boolean;
  v_recipients  uuid[] := '{}';
  v_title       text;
  v_msg         text;
  v_link        text;
  v_type        text;
  v_key         text;
BEGIN
  -- Only when a step becomes active (new, re-activated) or gets a new assignee while active
  IF NEW.status IS DISTINCT FROM 'active' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'active'
     AND OLD.assigned_user_id IS NOT DISTINCT FROM NEW.assigned_user_id THEN
    RETURN NEW;
  END IF;

  SELECT project_id, task_id INTO v_inst FROM public.workflow_instances WHERE id = NEW.workflow_instance_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT id, node_type, label, entity_id, settings INTO v_node FROM public.workflow_nodes WHERE id = NEW.node_id;
  IF NOT FOUND OR v_node.node_type IN ('start', 'end', 'conditional', 'sync') THEN RETURN NEW; END IF;

  IF v_inst.project_id IS NOT NULL THEN
    SELECT id, name, account_id, shared_with_client INTO v_project FROM public.projects WHERE id = v_inst.project_id;
  END IF;

  v_is_client := v_node.node_type = 'client' OR COALESCE(v_node.settings->>'client_approval', '') = 'true';
  v_key := 'wfstep:' || NEW.id::text || ':' || COALESCE(NEW.assigned_user_id::text, '-') || ':' || COALESCE(NEW.activated_at, now())::text;

  IF v_is_client THEN
    -- Client-approval step: tell the client users of the project's account (only if the project is shared)
    IF v_project.id IS NOT NULL AND v_project.shared_with_client THEN
      SELECT COALESCE(array_agg(up.id), '{}') INTO v_recipients
      FROM public.user_profiles up
      WHERE up.is_client AND up.client_account_id = v_project.account_id AND up.is_active IS DISTINCT FROM false;
    END IF;
    v_type := 'approval_request';
    v_title := 'Your approval is needed';
    v_msg := format('"%s" on %s is waiting for your approval', v_node.label, v_project.name);
    v_link := '/client-portal/approvals';
  ELSE
    -- Internal step: the assignee, people assigned to this node, otherwise holders of the role /
    -- members of the department (through a role in it, or added directly)
    IF NEW.assigned_user_id IS NOT NULL THEN
      v_recipients := ARRAY[NEW.assigned_user_id];
    ELSE
      SELECT COALESCE(array_agg(DISTINCT x.uid), '{}') INTO v_recipients FROM (
        SELECT na.user_id AS uid FROM public.workflow_node_assignments na
          WHERE na.workflow_instance_id = NEW.workflow_instance_id AND na.node_id = NEW.node_id
        UNION
        SELECT ur.user_id FROM public.user_roles ur
          WHERE v_node.node_type IN ('role', 'approval') AND v_node.entity_id IS NOT NULL AND ur.role_id = v_node.entity_id
        UNION
        SELECT ur.user_id FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
          WHERE v_node.node_type = 'department' AND v_node.entity_id IS NOT NULL AND r.department_id = v_node.entity_id
        UNION
        SELECT dm.user_id FROM public.department_members dm
          WHERE v_node.node_type = 'department' AND v_node.entity_id IS NOT NULL AND dm.department_id = v_node.entity_id
      ) x;
    END IF;
    -- Never notify clients or deactivated users through an internal step
    SELECT COALESCE(array_agg(up.id), '{}') INTO v_recipients
    FROM public.user_profiles up
    WHERE up.id = ANY (v_recipients) AND NOT COALESCE(up.is_client, false) AND up.is_active IS DISTINCT FROM false;

    v_type := CASE WHEN v_node.node_type = 'approval' THEN 'approval_request' ELSE 'workflow_step' END;
    v_title := CASE WHEN v_node.node_type = 'approval' THEN 'Approval needed' ELSE 'Workflow step assigned' END;
    v_msg := CASE WHEN v_project.name IS NOT NULL
                  THEN format('"%s" on %s is waiting for you', v_node.label, v_project.name)
                  ELSE format('"%s" is waiting for you', v_node.label) END;
    v_link := CASE WHEN v_inst.project_id IS NOT NULL THEN '/projects/' || v_inst.project_id::text ELSE '/dashboard' END;
  END IF;

  IF COALESCE(array_length(v_recipients, 1), 0) = 0 THEN RETURN NEW; END IF;

  INSERT INTO public.notifications (user_id, title, message, type, link, project_id, dedupe_key)
  SELECT u, v_title, v_msg, v_type, v_link, v_inst.project_id, v_key FROM unnest(v_recipients) AS u
  ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- A notification problem must never block the workflow
  RAISE WARNING 'notify_workflow_step_active failed: %', SQLERRM;
  RETURN NEW;
END;
$$;
