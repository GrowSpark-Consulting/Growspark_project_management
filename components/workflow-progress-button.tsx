'use client';


import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { ArrowRight, CheckCircle2, XCircle, Send, Loader2, FileText, Clock, User } from 'lucide-react';
import { toast } from 'sonner';
import { workflowProgress } from '@/lib/client-queries';
import { useAuth } from '@/lib/hooks/useAuth';
import { hasPermission } from '@/lib/rbac';
import { Permission } from '@/lib/permissions';

interface WorkflowProgressButtonProps {
  projectId: string;
  workflowInstanceId: string | null;
  activeStepId?: string | null; // For parallel workflow support - specific step to progress
  externalDialogOpen?: boolean; // Allow external control of dialog state
  onDialogOpenChange?: (open: boolean) => void; // Callback when dialog state changes
  onProgress?: () => void;
}

interface WorkflowInstance {
  id: string;
  workflow_template_id: string;
  current_node_id: string | null;
  project_id: string | null;
  status: string;
  workflow_nodes?: {
    id: string;
    node_type: 'start' | 'department' | 'role' | 'approval' | 'form' | 'conditional' | 'sync' | 'end';
    label: string;
    settings: Record<string, unknown>;
    entity_id: string | null;
  };
  workflow_templates?: {
    id: string;
    name: string;
  };
  started_snapshot?: {
    nodes?: Record<string, unknown>[];
    connections?: Record<string, unknown>[];
    template_name?: string;
  } | null;
}

interface NextNodePreview {
  id: string;
  label: string;
  node_type: string;
  entity_id: string | null;
}

interface User {
  id: string;
  name: string;
  email: string;
}

interface FormField {
  id: string;
  type: 'text' | 'number' | 'date' | 'dropdown' | 'multiselect' | 'file' | 'textarea' | 'email' | 'checkbox' | 'url';
  label: string;
  required: boolean;
  placeholder?: string;
  options?: string[];
  defaultValue?: Record<string, unknown>;
  validation?: {
    min?: number;
    max?: number;
    pattern?: string;
    message?: string;
  };
  conditional?: {
    show_if: string;
    equals: Record<string, unknown>;
  };
}

interface FormTemplate {
  id: string;
  name: string;
  description: string | null;
  fields: FormField[];
}

// Helper function to render simple markdown (bold text) as React elements
function _renderMarkdownContent(content: string): React.ReactNode {
  if (!content) return null;

  // Handle edge cases like *text** or **text* by normalizing first
  const normalizedContent = content
    .replace(/^\*([^*]+)\*\*$/gm, '**$1**') // Fix *text** -> **text**
    .replace(/^\*\*([^*]+)\*$/gm, '**$1**'); // Fix **text* -> **text**

  // Split by **text** pattern and render bold parts
  const parts = normalizedContent.split(/(\*\*[^*]+\*\*)/g);

  return parts.map((part:any, index:any) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      // Remove the ** markers and render as bold
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    return <span key={index}>{part}</span>;
  });
}

export function WorkflowProgressButton({
  projectId,
  workflowInstanceId,
  activeStepId: externalActiveStepId,
  externalDialogOpen,
  onDialogOpenChange,
  onProgress,
}: WorkflowProgressButtonProps) {
  const router = useRouter();
  const { userProfile } = useAuth();
  const [loading, setLoading] = useState(false);
  const [internalDialogOpen, setInternalDialogOpen] = useState(false);

  // Track which workflow instance ID we've loaded data for
  // This prevents re-loading when focus changes (e.g., date picker) trigger re-renders
  // Using the instance ID instead of a boolean ensures we only reload when the actual instance changes
  const loadedWorkflowInstanceRef = useRef<string | null>(null);

  // Support both internal and external dialog control
  const dialogOpen = externalDialogOpen !== undefined ? externalDialogOpen : internalDialogOpen;
  const setDialogOpen = (open: boolean) => {
    // When explicitly closing the dialog, reset the loaded ref so we reload next time
    if (!open) {
      loadedWorkflowInstanceRef.current = null;
    }
    setInternalDialogOpen(open);
    onDialogOpenChange?.(open);
  };

  // Track the active step ID (either from prop or loaded from API)
  const [currentActiveStepId, setCurrentActiveStepId] = useState<string | null>(null);
  const [workflowInstance, setWorkflowInstance] = useState<WorkflowInstance | null>(null);
  const [nextNode, setNextNode] = useState<NextNodePreview | null>(null);
  const [decision, setDecision] = useState<'approved' | 'rejected' | undefined>();
  const [feedback, setFeedback] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [availableUsers, setAvailableUsers] = useState<User[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string>('');

  // Parallel workflow user assignment - for when form node forks to multiple approval nodes
  const [nextNodes, setNextNodes] = useState<NextNodePreview[]>([]);
  const [usersPerNode, setUsersPerNode] = useState<Record<string, User[]>>({});
  const [selectedUserPerNode, setSelectedUserPerNode] = useState<Record<string, string>>({});

  // Label of the current step when it is a client approval (decided in the client portal), else null
  const [clientApprovalStep, setClientApprovalStep] = useState<string | null>(null);

  // Stale data detection - track when workflow was last loaded vs current state
  const [_isStaleData, setIsStaleData] = useState(false);
  const [lastKnownUpdatedAt, setLastKnownUpdatedAt] = useState<string | null>(null);

  // Permission state
  const [canExecuteWorkflows, setCanExecuteWorkflows] = useState<boolean | null>(null);
  const [checkingPermissions, setCheckingPermissions] = useState(true);
  const [hasRequiredRole, setHasRequiredRole] = useState<boolean>(false); // Default false - only show after check passes
  const [_requiredRoleName, setRequiredRoleName] = useState<string | null>(null);
  const [isAssignedToProject, setIsAssignedToProject] = useState<boolean>(false); // Default false - only show after check passes
  const [checkingAccessPermissions, setCheckingAccessPermissions] = useState(true); // Track access permission loading

  // Pipeline state - when user is assigned to a future step that hasn't been reached
  const [isPipelineProject, setIsPipelineProject] = useState(false);
  const [assignedFutureStepName, setAssignedFutureStepName] = useState<string | null>(null);
  const [currentStepName, setCurrentStepName] = useState<string | null>(null);

  // Parallel approvers state - show other users approving in parallel
  const [_parallelApprovers, setParallelApprovers] = useState<Array<{
    id: string;
    userName: string;
    nodeName: string;
    completed: boolean;
    decision: string | null;
  }>>([]);
  const [_isParallelApproval, setIsParallelApproval] = useState(false);

  // Form state
  const [formTemplate, setFormTemplate] = useState<FormTemplate | null>(null);
  const [formData, setFormData] = useState<Record<string, any>>({});

  // Auto-save key for localStorage - unique per workflow instance + step
  const getFormSaveKey = useCallback(() => {
    const stepId = externalActiveStepId || currentActiveStepId || 'default';
    return `workflow-form-draft-${workflowInstanceId}-${stepId}`;
  }, [workflowInstanceId, externalActiveStepId, currentActiveStepId]);

  // Auto-save form data to localStorage whenever it changes
  useEffect(() => {
    if (!workflowInstanceId || !dialogOpen || Object.keys(formData).length === 0) return;

    const saveKey = getFormSaveKey();
    try {
      localStorage.setItem(saveKey, JSON.stringify({
        formData,
        decision,
        feedback,
        selectedUserId,
        selectedUserPerNode,
        savedAt: new Date().toISOString(),
      }));
    } catch (e: unknown) {
      // Error handled silently
    }
  }, [formData, decision, feedback, selectedUserId, selectedUserPerNode, workflowInstanceId, dialogOpen, getFormSaveKey]);

  // Load saved form data from localStorage when dialog opens
  const loadSavedFormData = useCallback(() => {
    const saveKey = getFormSaveKey();
    try {
      const saved = localStorage.getItem(saveKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        // Only restore if saved within last 24 hours
        const savedAt = new Date(parsed.savedAt);
        const hoursSinceSave = (Date.now() - savedAt.getTime()) / (1000 * 60 * 60);
        if (hoursSinceSave < 24) {
          return parsed;
        } else {
          // Clear stale data
          localStorage.removeItem(saveKey);
        }
      }
    } catch (e: unknown) {
      // Error handled silently
    }
    return null;
  }, [getFormSaveKey]);

  // Clear saved form data (call after successful submission)
  const clearSavedFormData = useCallback(() => {
    const saveKey = getFormSaveKey();
    try {
      localStorage.removeItem(saveKey);
    } catch (e: unknown) {
      // Error handled silently
    }
  }, [getFormSaveKey]);

  // Parallel workflow state
  const [branchId, setBranchId] = useState<string | null>(null);
  const [existingFormData, setExistingFormData] = useState<{ data: Record<string, any>; fields?: any[]; formName?: string } | null>(null);
  const [_isSuperadmin, setIsSuperadmin] = useState(false);

  // Project issues state - show open issues to inform decision-making
  const [_projectIssues, setProjectIssues] = useState<Array<{
    id: string;
    content: string;
    status: string;
    created_at: string;
  }>>([]);
  const [_loadingIssues, setLoadingIssues] = useState(false);

  // Check permission when component mounts or user changes
  useEffect(() => {
    async function checkPermissions() {
      if (!userProfile) {
        setCanExecuteWorkflows(false);
        setCheckingPermissions(false);
        return;
      }

      try {
        const canExecute = await hasPermission(userProfile, Permission.EXECUTE_WORKFLOWS, { projectId });
        setCanExecuteWorkflows(canExecute);
      } catch (error: unknown) {
        // Error handled silently
        setCanExecuteWorkflows(false);
      } finally {
        setCheckingPermissions(false);
      }
    }

    checkPermissions();
  }, [userProfile, projectId]);

  // Check role access AND project assignment when component mounts or workflow instance changes
  useEffect(() => {
    async function checkAccessPermissions() {
      setCheckingAccessPermissions(true);
      setClientApprovalStep(null);

      if (!workflowInstanceId || !userProfile) {
        // No workflow instance - don't show button at all (handled by render)
        setHasRequiredRole(false);
        setIsAssignedToProject(false);
        setCheckingAccessPermissions(false);
        return;
      }

      try {
        // The checks run on the server as the user (lib/workflow-progress-data.ts)
        const { data: access } = await workflowProgress(workflowInstanceId, { view: 'access', activeStepId: externalActiveStepId || undefined });
        if (!access) return;
        if (access.clientApprovalStep !== undefined) setClientApprovalStep(access.clientApprovalStep);
        if (access.isSuperadmin !== undefined) setIsSuperadmin(access.isSuperadmin);
        if (access.hasRequiredRole !== undefined) setHasRequiredRole(access.hasRequiredRole);
        if (access.requiredRoleName !== undefined) setRequiredRoleName(access.requiredRoleName);
        if (access.isAssignedToProject !== undefined) setIsAssignedToProject(access.isAssignedToProject);
        if (access.isPipelineProject !== undefined) setIsPipelineProject(access.isPipelineProject);
        if (access.assignedFutureStepName !== undefined) setAssignedFutureStepName(access.assignedFutureStepName);
        if (access.currentStepName !== undefined) setCurrentStepName(access.currentStepName);
      } catch (error: unknown) {
        // On error, default to hiding the button for safety
        setHasRequiredRole(false);
        setIsAssignedToProject(false);
      } finally {
        setCheckingAccessPermissions(false);
      }
    }

    checkAccessPermissions();
  }, [workflowInstanceId, userProfile, externalActiveStepId]);

  const loadWorkflowData = useCallback(async () => {
    try {
      setLoading(true);
      // The lookups run on the server as the user (lib/workflow-progress-data.ts)
      const { data: d } = await workflowProgress(workflowInstanceId as string, {
        view: 'data', projectId, activeStepId: externalActiveStepId || undefined, branchId: branchId || undefined,
      });
      if (!d) return;

      // Check for stale data - if workflow was updated since we last loaded
      const currentUpdatedAt = d.updatedAt;
      if (lastKnownUpdatedAt && currentUpdatedAt && lastKnownUpdatedAt !== currentUpdatedAt) {
        // Workflow was updated by someone else
        setIsStaleData(true);
      } else {
        setIsStaleData(false);
      }
      setLastKnownUpdatedAt(currentUpdatedAt);

      if (d.branchId !== undefined) setBranchId(d.branchId);
      setCurrentActiveStepId(d.activeStepIdToUse);
      setWorkflowInstance(d.instance);
      setExistingFormData(d.existingFormData);

      // The step's editable form: pre-filled after a rejection, or from an auto-saved draft
      if (d.formTemplate) {
        setFormTemplate(d.formTemplate);
        const initialData: Record<string, any> = {};
        for (const field of (d.formTemplate.fields as FormField[]) || []) {
          if (field.defaultValue !== undefined) {
            initialData[field.id] = field.defaultValue;
          } else if (field.type === 'checkbox') {
            initialData[field.id] = false;
          } else if (field.type === 'multiselect') {
            initialData[field.id] = [];
          } else {
            initialData[field.id] = '';
          }
        }
        if (d.previousFormResponses) {
          setFormData({ ...initialData, ...d.previousFormResponses });
        } else {
          const savedDraft = loadSavedFormData();
          if (savedDraft?.formData && Object.keys(savedDraft.formData).length > 0) {
            setFormData({ ...initialData, ...savedDraft.formData });
            if (savedDraft.decision) setDecision(savedDraft.decision);
            if (savedDraft.feedback) setFeedback(savedDraft.feedback);
            if (savedDraft.selectedUserId) setSelectedUserId(savedDraft.selectedUserId);
            if (savedDraft.selectedUserPerNode) setSelectedUserPerNode(savedDraft.selectedUserPerNode);
          } else {
            setFormData(initialData);
          }
        }
      } else {
        setFormTemplate(null);
        setFormData({});
      }

      // Next step(s) preview, and the people who can be picked for them
      if (d.nextNodes.length > 0) {
        setNextNode(d.nextNodes[0] as any);
        setNextNodes(d.nextNodes as any);
        if (d.usersPerNode) {
          setUsersPerNode(d.usersPerNode);
          setSelectedUserPerNode({}); // Reset selections
        } else if (d.availableUsers) {
          setAvailableUsers(d.availableUsers);
        }
      }

      // Open project issues, and others approving in parallel
      setProjectIssues(d.projectIssues || []);
      setLoadingIssues(false);
      setIsParallelApproval(!!d.parallelApprovers);
      setParallelApprovers(d.parallelApprovers || []);
    } catch (error: unknown) {
      // Error handled silently
    } finally {
      setLoading(false);
    }
  }, [workflowInstanceId, projectId, externalActiveStepId, branchId, lastKnownUpdatedAt, loadSavedFormData]);

  useEffect(() => {
    if (workflowInstanceId && dialogOpen) {
      // Build a unique key for this dialog session: instanceId + activeStepId
      // This ensures we reload if either changes, but not on focus changes
      const sessionKey = `${workflowInstanceId}-${externalActiveStepId || 'default'}`;

      // Only load data if we haven't already loaded for this specific session
      if (loadedWorkflowInstanceRef.current !== sessionKey) {
        loadedWorkflowInstanceRef.current = sessionKey;
        loadWorkflowData();
      }
    }
    // Note: We intentionally do NOT reset the ref when dialogOpen becomes false
    // This prevents the issue where date picker/select focus changes briefly toggle dialogOpen
    // The ref will naturally reset when a different workflowInstanceId is loaded
  }, [workflowInstanceId, dialogOpen, externalActiveStepId, loadWorkflowData]);

  // Helper to check if a field should be visible based on conditional logic
  const isFieldVisible = (field: FormField): boolean => {
    if (!field.conditional) return true;
    const conditionalFieldValue = formData[field.conditional.show_if];
    return conditionalFieldValue === field.conditional.equals;
  };

  // Validate form data
  const validateFormData = (): string | null => {
    if (!formTemplate) return null;

    for (const field of formTemplate.fields) {
      // Skip hidden fields
      if (!isFieldVisible(field)) continue;

      const value = formData[field.id];

      // Check required fields
      if (field.required) {
        if (value === undefined || value === null || value === '' ||
            (Array.isArray(value) && value.length === 0)) {
          return `${field.label} is required`;
        }
      }

      // Type-specific validation
      if (value !== undefined && value !== null && value !== '') {
        switch (field.type) {
          case 'email':
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(String(value))) {
              return `${field.label} must be a valid email address`;
            }
            break;
          case 'number':
            if (isNaN(Number(value))) {
              return `${field.label} must be a number`;
            }
            if (field.validation?.min !== undefined && Number(value) < (field.validation.min as number)) {
              return `${field.label} must be at least ${field.validation.min}`;
            }
            if (field.validation?.max !== undefined && Number(value) > (field.validation.max as number)) {
              return `${field.label} must be at most ${field.validation.max}`;
            }
            break;
        }
      }
    }

    return null;
  };

  const handleProgressWorkflow = async () => {
    if (!workflowInstanceId) return;

    const currentNode = workflowInstance?.workflow_nodes;
    // Allow progressing when currentNode is null - this means workflow hasn't started yet
    // The backend will handle moving from start node to first real node

    // For approval nodes, decision is required
    if (currentNode?.node_type === 'approval' && !decision) {
      toast.error('Please select an approval decision');
      return;
    }

    // For form nodes, validate the form data
    if (formTemplate) {
      const validationError = validateFormData();
      if (validationError) {
        toast.error(validationError);
        return;
      }
    }

    // User assignment validation - handle both single and parallel branches
    // SYNC NODES: Always require user assignment (the whole point is to assign the next step)
    if (nextNodes.length > 1 && Object.keys(usersPerNode).length > 0) {
      // Parallel branches - validate all assignments
      const nodesRequiringAssignment = nextNodes.filter((node:any) =>
        usersPerNode[node.id] && usersPerNode[node.id].length > 0
      );

      for (const node of nodesRequiringAssignment) {
        if (!selectedUserPerNode[node.id]) {
          toast.error(`Please select a user for "${node.label}"`);
          return;
        }
      }
    } else if (availableUsers.length > 0 && !selectedUserId) {
      // Single branch - legacy validation
      toast.error('Please select a user to assign this project to');
      return;
    } else if (isSyncNode && !selectedUserId && availableUsers.length === 0) {
      // Sync node with no available users - this shouldn't happen, but handle gracefully
      toast.error('No users available to assign for the next step');
      return;
    }

    try {
      setSubmitting(true);

      let formResponseId: string | undefined;
      let inlineFormData: Record<string, Record<string, unknown>> | undefined;

      // If there's a form, handle it
      if (formTemplate) {
        // Check if this is an inline form (stored in node settings) or a linked form template
        const isInlineForm = formTemplate.id.startsWith('inline-');

        if (isInlineForm) {
          // For inline forms, pass the form data directly to the workflow progress endpoint
          inlineFormData = {
            formName: formTemplate.name as any,
            formDescription: formTemplate.description as any,
            fields: formTemplate.fields as any,
            responses: formData,
          };
        } else {
          // For linked form templates, submit to the form_responses table
          const formResponse = await fetch('/api/workflows/forms/responses', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              formTemplateId: formTemplate.id,
              responseData: formData,
            }),
          });

          const formResult = await formResponse.json();

          if (!formResponse.ok || formResult.error) {
            throw new Error(formResult.error || 'Failed to submit form');
          }

          formResponseId = formResult.id;
        }
      }

      // Build assignments object for parallel branches
      const assignedUsersPerNode = nextNodes.length > 1 && Object.keys(selectedUserPerNode).length > 0
        ? selectedUserPerNode
        : undefined;

      const response = await fetch('/api/workflows/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflowInstanceId,
          activeStepId: currentActiveStepId, // Include for parallel workflow support
          decision,
          feedback,
          assignedUserId: selectedUserId || undefined,
          assignedUsersPerNode, // NEW: map of nodeId -> userId for parallel branches
          formResponseId,
          formData: inlineFormData, // Include inline form data if present
        }),
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || 'Failed to progress workflow');
      }

      toast.success('Project sent to next step successfully');

      // Clear the auto-saved draft since submission was successful
      clearSavedFormData();

      setDialogOpen(false);
      setDecision(undefined);
      setFeedback('');
      setFormData({});
      setFormTemplate(null);
      setSelectedUserId('');
      setCurrentActiveStepId(null);

      // Reset workflow state to hide button immediately
      setWorkflowInstance(null);
      setNextNode(null);
      setNextNodes([]);
      setAvailableUsers([]);
      setUsersPerNode({});
      setSelectedUserPerNode({});

      // Call parent callback to trigger refresh
      onProgress?.();

      // Refresh server data
      router.refresh();
    } catch (error: any) {
      toast.error(error?.message || 'Failed to progress workflow');
    } finally {
      setSubmitting(false);
    }
  };

  // Don't show button if no workflow instance
  if (!workflowInstanceId) {
    return null;
  }

  // Don't show button while checking permissions (either EXECUTE_WORKFLOWS or role/assignment)
  if (checkingPermissions || checkingAccessPermissions) {
    return (
      <Button disabled className="gap-2" size="lg">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading...
      </Button>
    );
  }

  // Don't show button if user doesn't have permission
  if (!canExecuteWorkflows) {
    return null;
  }

  // Don't show button if user is not assigned to the project
  if (!isAssignedToProject) {
    return null;
  }

  // Don't show button if user doesn't have the required role for this workflow step
  // BUT if they're assigned to a future step, show an explanation instead
  if (!hasRequiredRole) {
    if (isPipelineProject && assignedFutureStepName) {
      // User is assigned to a future step - show explanation
      return (
        <div className="flex items-center gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm">
          <Clock className="w-4 h-4 text-blue-600 flex-shrink-0" />
          <div className="text-blue-800">
            <span className="font-medium">In the pipeline:</span>{' '}
            You&apos;re assigned to &quot;{assignedFutureStepName}&quot; which hasn&apos;t been reached yet.
            <span className="text-blue-600"> Current step: {currentStepName}</span>
          </div>
        </div>
      );
    }
    return null;
  }

  const currentNode = workflowInstance?.workflow_nodes;
  const isApprovalNode = currentNode?.node_type === 'approval';
  const isFormNode = currentNode?.node_type === 'form';
  const isSyncNode = currentNode?.node_type === 'sync';
  // formTemplate is loaded from either inline settings or linked form_template_id
  const _hasFormTemplate = formTemplate !== null;

  // The client approves this step in the client portal; the server refuses it from here too
  if (clientApprovalStep !== null) {
    return (
      <div className="flex items-center gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm">
        <Clock className="w-4 h-4 text-blue-600 flex-shrink-0" />
        <div className="text-blue-800">
          <span className="font-medium">Waiting for the client:</span>{' '}
          &quot;{clientApprovalStep}&quot; is approved by the client in the client portal.
        </div>
      </div>
    );
  }


  return (
    <>
      <Button
        onClick={() => setDialogOpen(true)}
        className="gap-2"
        size="lg"
      >
        <Send className="w-4 h-4" />
        Send to Next Step
      </Button>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent
          className="max-w-2xl max-h-[90vh] flex flex-col"
          onInteractOutside={(e) => {
            // Prevent dialog from closing when interacting with portaled elements
            // like date pickers, select dropdowns, etc.
            e.preventDefault();
          }}
        >
          <DialogHeader className="flex-shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <ArrowRight className="w-5 h-5" />
              Progress Workflow
            </DialogTitle>
            <DialogDescription>
              {isApprovalNode
                ? 'Review and approve or reject this project'
                : isFormNode
                ? 'Complete the required form before progressing'
                : isSyncNode
                ? 'Assign someone to the next workflow step'
                : 'Send this project to the next workflow step'}
            </DialogDescription>
          </DialogHeader>

          {loading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
            </div>
          )}
          {!loading && (
            <div className="space-y-4 py-4 overflow-y-auto flex-1 min-h-0">
              {/* Current and Next Step Information */}
              {currentNode && (nextNode || nextNodes.length > 0) && (
                <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg space-y-3">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <Clock className="w-4 h-4 text-blue-600" />
                      <span className="text-sm font-medium text-blue-900">Current Step</span>
                    </div>
                    <div className="flex items-center gap-2 ml-6">
                      <Badge className="bg-blue-100 text-blue-800 text-xs">
                        {currentNode.node_type}
                      </Badge>
                      <span className="text-sm text-blue-800">{currentNode.label}</span>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <ArrowRight className="w-4 h-4 text-blue-600" />
                      <span className="text-sm font-medium text-blue-900">Next Step</span>
                    </div>
                    {nextNodes.length > 1 ? (
                      <div className="ml-6 space-y-2">
                        {nextNodes.map((node:any, index:number) => (
                          <div key={node.id} className="flex items-center gap-2">
                            <Badge className="bg-purple-100 text-purple-800 text-xs">
                              {node.node_type}
                            </Badge>
                            <span className="text-sm text-blue-800">{node.label}</span>
                            {index < nextNodes.length - 1 && <span className="text-xs text-gray-400">&</span>}
                          </div>
                        ))}
                        <p className="text-xs text-blue-600">Multiple parallel branches</p>
                      </div>
                    ) : nextNode ? (
                      <div className="flex items-center gap-2 ml-6">
                        <Badge className="bg-purple-100 text-purple-800 text-xs">
                          {nextNode.node_type}
                        </Badge>
                        <span className="text-sm text-blue-800">{nextNode.label}</span>
                      </div>
                    ) : null}
                  </div>

                  {availableUsers.length > 0 && nextNodes.length <= 1 && (
                    <div className="text-xs text-blue-600 flex items-center gap-1">
                      <User className="w-3 h-3" />
                      {availableUsers.length} user{availableUsers.length !== 1 ? 's' : ''} available for assignment
                    </div>
                  )}
                </div>
              )}

              {nextNodes.length > 1 && Object.keys(usersPerNode).length > 0 && (
                <div className="space-y-4">
                  <Label className="text-sm font-medium">Assign Users to Each Step *</Label>
                  <p className="text-xs text-gray-500 -mt-2">
                    Select a user for each parallel workflow branch
                  </p>
                  {nextNodes.map((node:any) => {
                    const nodeUsers = usersPerNode[node.id] || [];
                    if (nodeUsers.length === 0) return null;

                    return (
                      <div key={node.id} className="space-y-2 p-3 bg-gray-50 rounded-lg border">
                        <div className="flex items-center gap-2">
                          <Badge className="bg-purple-100 text-purple-800 text-xs">
                            {node.node_type}
                          </Badge>
                          <span className="font-medium text-sm">{node.label}</span>
                        </div>
                        <Select
                          value={selectedUserPerNode[node.id] || ''}
                          onValueChange={(value) =>
                            setSelectedUserPerNode((prev) => ({ ...prev, [node.id]: value }))
                          }
                        >
                          <SelectTrigger>
                            <SelectValue placeholder={`Select ${node.label} assignee`} />
                          </SelectTrigger>
                          <SelectContent>
                            {nodeUsers.map((user:any) => (
                              <SelectItem key={(user as any).id} value={(user as any).id}>
                                {(user as any).name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* User Assignment Selection - single branch (legacy) */}
              {nextNodes.length <= 1 && availableUsers.length > 0 && (
                <div className={`space-y-2 ${isSyncNode ? 'p-4 bg-amber-50 border border-amber-200 rounded-lg' : ''}`}>
                  <Label htmlFor="assign-user" className={isSyncNode ? 'text-amber-900 font-semibold' : ''}>
                    {isSyncNode ? 'Assign Next Step To *' : 'Assign To *'}
                  </Label>
                  <Select value={selectedUserId} onValueChange={setSelectedUserId}>
                    <SelectTrigger className={isSyncNode ? 'border-amber-300' : ''}>
                      <SelectValue placeholder={isSyncNode ? 'Select who will handle the next step' : 'Select a user to assign'} />
                    </SelectTrigger>
                    <SelectContent>
                      {availableUsers.map((user:any) => (
                        <SelectItem key={(user as any).id} value={(user as any).id}>
                          {nextNode?.label} - {(user as any).name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className={`text-xs ${isSyncNode ? 'text-amber-700' : 'text-gray-500'}`}>
                    {isSyncNode
                      ? 'As the sync leader, you must assign someone to continue the workflow'
                      : 'Select the user who will handle this project at the next step'}
                  </p>
                </div>
              )}

              {(isApprovalNode && (
                <div className="space-y-3">
                  <Label>Decision *</Label>
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      type="button"
                      variant={decision === 'approved' ? 'default' : 'outline'}
                      onClick={() => setDecision('approved')}
                      className="flex items-center gap-2"
                    >
                      <CheckCircle2 className="w-4 h-4" />
                      Approve
                    </Button>
                    <Button
                      type="button"
                      variant={decision === 'rejected' ? 'destructive' : 'outline'}
                      onClick={() => setDecision('rejected')}
                      className="flex items-center gap-2"
                    >
                      <XCircle className="w-4 h-4" />
                      Reject
                    </Button>
                  </div>
                </div>
              )) as React.ReactNode}

              {/* Feedback/Notes */}
              {((isApprovalNode || currentNode?.settings?.allow_feedback) && (
                <div className="space-y-2">
                  <Label htmlFor="feedback">
                    {isApprovalNode ? 'Feedback (Optional)' : 'Notes (Optional)'}
                  </Label>
                  <Textarea
                    id="feedback"
                    value={feedback}
                    onChange={(e) => setFeedback(e.target.value)}
                    placeholder={
                      isApprovalNode
                        ? 'Provide feedback or comments...'
                        : 'Add any notes about the handoff...'
                    }
                    rows={4}
                  />
                </div>
              )) as React.ReactNode}

              {/* Existing Form Data (already submitted - show read-only) */}
              {(existingFormData && (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 pb-2 border-b">
                    <FileText className="w-5 h-5 text-green-600" />
                    <div className="flex-1">
                      <h4 className="font-medium text-green-900">Form Already Submitted</h4>
                      <p className="text-xs text-green-700">This form was completed in a previous step</p>
                    </div>
                    <Badge className="bg-green-100 text-green-800">Completed</Badge>
                  </div>

                  <div className="p-4 bg-gray-50 rounded-lg space-y-3">
                    {existingFormData.fields?.map((field: any) => {
                      const value = existingFormData.data[(field.id as string)];
                      if (value === undefined || value === null || value === '') return null;

                      return (
                        <div key={field.id as string} className="flex flex-col">
                          <span className="text-xs text-gray-500 font-medium">{field.label as string}</span>
                          <span className="text-sm text-gray-900">
                            {Array.isArray(value) ? value.join(', ') :
                             typeof value === 'boolean' ? (value ? 'Yes' : 'No') :
                             String(value)}
                          </span>
                        </div>
                      );
                    }) || Object.entries(existingFormData.data).map(([key, value]) => (
                      <div key={key} className="flex flex-col">
                        <span className="text-xs text-gray-500 font-medium">{key}</span>
                        <span className="text-sm text-gray-900">
                          {Array.isArray(value) ? value.join(', ') :
                           typeof value === 'boolean' ? (value ? 'Yes' : 'No') :
                           String(value)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )) as React.ReactNode}

              {/* Form Fields (for nodes with form templates) - only show if no existing submission */}
              {(formTemplate && !existingFormData && (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 pb-2 border-b">
                    <FileText className="w-5 h-5 text-purple-600" />
                    <div>
                      <h4 className="font-medium text-purple-900">{formTemplate.name}</h4>
                      {formTemplate.description && (
                        <p className="text-xs text-purple-700">{formTemplate.description}</p>
                      )}
                    </div>
                  </div>

                  {formTemplate.fields.map((field:any) => {
                    // Check conditional visibility
                    if (!isFieldVisible(field)) return null;

                    return (
                      <div key={field.id} className="space-y-2">
                        <Label htmlFor={`form-${field.id}`}>
                          {field.label}
                          {field.required && <span className="text-red-500 ml-1">*</span>}
                        </Label>

                        {/* Text Input */}
                        {field.type === 'text' && (
                          <Input
                            id={`form-${field.id}`}
                            type="text"
                            placeholder={field.placeholder}
                            value={String(formData[field.id] || '')}
                            onChange={(e) => setFormData({ ...formData, [field.id]: e.target.value })}
                          />
                        )}

                        {/* Email Input */}
                        {field.type === 'email' && (
                          <Input
                            id={`form-${field.id}`}
                            type="email"
                            placeholder={field.placeholder || 'email@example.com'}
                            value={String(formData[field.id] || '')}
                            onChange={(e) => setFormData({ ...formData, [field.id]: e.target.value })}
                          />
                        )}

                        {/* URL Input */}
                        {field.type === 'url' && (
                          <Input
                            id={`form-${field.id}`}
                            type="url"
                            placeholder={field.placeholder || 'https://example.com'}
                            value={String(formData[field.id] || '')}
                            onChange={(e) => setFormData({ ...formData, [field.id]: e.target.value })}
                          />
                        )}

                        {/* Number Input */}
                        {field.type === 'number' && (
                          <Input
                            id={`form-${field.id}`}
                            type="number"
                            placeholder={field.placeholder}
                            min={field.validation?.min as number}
                            max={field.validation?.max as number}
                            value={String(formData[field.id] || '')}
                            onChange={(e) => setFormData({ ...formData, [field.id]: e.target.value })}
                          />
                        )}

                        {/* Date Input */}
                        {field.type === 'date' && (
                          <Input
                            id={`form-${field.id}`}
                            type="date"
                            value={String(formData[field.id] || '')}
                            onChange={(e) => setFormData({ ...formData, [field.id]: e.target.value })}
                          />
                        )}

                        {/* Textarea */}
                        {field.type === 'textarea' && (
                          <Textarea
                            id={`form-${field.id}`}
                            placeholder={field.placeholder}
                            value={String(formData[field.id] || '')}
                            onChange={(e) => setFormData({ ...formData, [field.id]: e.target.value })}
                            rows={4}
                          />
                        )}

                        {/* Dropdown Select */}
                        {field.type === 'dropdown' && field.options && (
                          <Select
                            value={String(formData[field.id] || '')}
                            onValueChange={(value) => setFormData({ ...formData, [field.id]: value })}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder={field.placeholder || 'Select an option'} />
                            </SelectTrigger>
                            <SelectContent>
                              {field.options.map((option:any) => (
                                <SelectItem key={option} value={option}>
                                  {option}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}

                        {/* Checkbox */}
                        {field.type === 'checkbox' && (
                          <div className="flex items-center space-x-2">
                            <Checkbox
                              id={`form-${field.id}`}
                              checked={Boolean(formData[field.id])}
                              onCheckedChange={(checked) => setFormData({ ...formData, [field.id]: checked })}
                            />
                            <label
                              htmlFor={`form-${field.id}`}
                              className="text-sm text-gray-600 cursor-pointer"
                            >
                              {field.placeholder || 'Yes'}
                            </label>
                          </div>
                        )}

                        {/* Multiselect (as multiple checkboxes) */}
                        {field.type === 'multiselect' && field.options && (
                          <div className="space-y-2">
                            {field.options.map((option:any) => (
                              <div key={option} className="flex items-center space-x-2">
                                <Checkbox
                                  id={`form-${field.id}-${option}`}
                                  checked={Array.isArray(formData[field.id]) && (formData[field.id] as any[]).includes(option)}
                                  onCheckedChange={(checked) => {
                                    const currentValues = Array.isArray(formData[field.id]) ? formData[field.id] as any[] : [];
                                    const newValues = checked
                                      ? [...currentValues, option]
                                      : currentValues.filter((v: any) => v !== option);
                                    setFormData({ ...formData, [field.id]: newValues });
                                  }}
                                />
                                <label
                                  htmlFor={`form-${field.id}-${option}`}
                                  className="text-sm text-gray-600 cursor-pointer"
                                >
                                  {option}
                                </label>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* File Input (placeholder - requires backend file handling) */}
                        {field.type === 'file' && (
                          <div className="p-4 bg-gray-50 border border-dashed border-gray-300 rounded-lg text-center">
                            <p className="text-sm text-gray-500">
                              File upload coming soon
                            </p>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )) as React.ReactNode}

              {/* Show message if form node but form template not found */}
              {(isFormNode && !formTemplate && !loading && (
                <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                  <p className="text-sm text-yellow-800">
                    This step requires a form, but no form template has been configured for this workflow node.
                  </p>
                </div>
              )) as React.ReactNode}
            </div>
          )}

          <DialogFooter className="flex-shrink-0 border-t pt-4 mt-4">
            {/* Auto-save indicator */}
            {formTemplate && Object.keys(formData).length > 0 && (
              <div className="flex-1 text-xs text-gray-500 flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3 text-green-500" />
                Draft auto-saved
              </div>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              onClick={handleProgressWorkflow}
              disabled={submitting || loading || (isApprovalNode && !decision) || (isSyncNode && availableUsers.length > 0 && !selectedUserId)}
            >
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  {isSyncNode ? 'Assigning...' : 'Sending...'}
                </>
              ) : (
                <>
                  <Send className="w-4 h-4 mr-2" />
                  {isApprovalNode
                    ? `${decision === 'approved' ? 'Approve' : 'Reject'} & Send`
                    : isSyncNode
                    ? 'Assign & Continue'
                    : 'Send to Next Step'}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
