'use client';

import { useState, useEffect } from 'react';
import { addDays } from 'date-fns';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { PlusIcon } from 'lucide-react';
import { toast } from 'sonner';
import { createClientSupabase } from '@/lib/supabase';

import { useAuth } from '@/lib/hooks/useAuth';
import { hasPermission } from '@/lib/rbac';
import { Permission } from '@/lib/permissions';

interface ProjectCreationDialogProps {
  children?: React.ReactNode;
  onProjectCreated?: (project: any) => void;
  departmentId?: string;
  accountId?: string;
  initialStartDate?: Date;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

interface Account {
  id: string;
  name: string;
}

interface WorkflowTemplate {
  id: string;
  name: string;
  description: string | null;
}

export default function ProjectCreationDialog({
  children,
  onProjectCreated,
  accountId: propAccountId,
  initialStartDate,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange
}: ProjectCreationDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen !== undefined ? controlledOpen : internalOpen;
  const setOpen = controlledOnOpenChange || setInternalOpen;
  const [loading, setLoading] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [accountsLoadFailed, setAccountsLoadFailed] = useState(false);
  // Inline "new account": a brand-new workspace has no accounts, and every project needs one
  const [showNewAccount, setShowNewAccount] = useState(false);
  const [newAccountName, setNewAccountName] = useState('');
  const [addingAccount, setAddingAccount] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowTemplate[]>([]);
  const { userProfile } = useAuth();
  const [_canCreateProject, setCanCreateProject] = useState(false);

  // Check permissions
  useEffect(() => {
    if (!userProfile || !propAccountId) return;

    async function checkPermissions() {
      const canCreate = await hasPermission(userProfile, Permission.MANAGE_PROJECTS, { accountId: propAccountId });
      setCanCreateProject(canCreate);
    }
    
    checkPermissions();
  }, [userProfile, propAccountId]);

  // Form state - initialize with props if provided
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    accountId: propAccountId || '',
    workflowTemplateId: null as string | null,
    startDate: initialStartDate
      ? initialStartDate.toLocaleDateString('en-CA')
      : new Date().toLocaleDateString('en-CA'),
    endDate: initialStartDate
      ? addDays(initialStartDate, 30).toLocaleDateString('en-CA')
      : addDays(new Date(), 30).toLocaleDateString('en-CA'),
    priority: 'medium' as 'low' | 'medium' | 'high' | 'urgent',
    estimatedHours: '',
  });

  // Update form data when props change
  useEffect(() => {
    if (propAccountId) {
      setFormData(prev => ({ ...prev, accountId: propAccountId }));
    }
  }, [propAccountId]);

  useEffect(() => {
    if (initialStartDate) {
      setFormData(prev => ({
        ...prev,
        startDate: initialStartDate.toLocaleDateString('en-CA'),
        endDate: addDays(initialStartDate, 30).toLocaleDateString('en-CA'),
      }));
    }
  }, [initialStartDate]);

  // Load accounts and workflows when dialog opens
  useEffect(() => {
    const loadData = async () => {
      try {
        const supabase = createClientSupabase();
        if (!supabase) return;

        // Load accounts
        const { data: accountsData, error: accountsError } = await supabase
          .from('accounts')
          .select('id, name')
          .order('name');

        if (accountsError) {
          setAccountsLoadFailed(true);
          toast.error('Failed to load accounts');
        } else {
          setAccountsLoadFailed(false);
          setAccounts(accountsData || []);
          setAccountsLoaded(true);
        }

        // Load workflows
        const { data: workflowsData, error: workflowsError } = await supabase
          .from('workflow_templates')
          .select('id, name, description')
          .eq('is_active', true)
          .order('name');

        if (workflowsError) {
          toast.error('Failed to load workflows');
        } else {
          setWorkflows(workflowsData || []);
        }
      } catch (error: unknown) {
        toast.error('Failed to load form data');
      }
    };

    if (open) {
      loadData();
    }
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!formData.accountId) {
      toast.error('Please select an account for this project.');
      return;
    }

    if (!formData.estimatedHours || parseInt(formData.estimatedHours) <= 0) {
      toast.error('Please enter estimated hours for this project.');
      return;
    }

    // Check permission for the selected account
    if (userProfile && formData.accountId) {
      const canCreate = await hasPermission(userProfile, Permission.MANAGE_PROJECTS, { accountId: formData.accountId });
      if (!canCreate) {
        toast.error('You do not have permission to create projects for this account.');
        return;
      }
    }
    
    setLoading(true);

    try {
      const supabase = createClientSupabase();
      if (!supabase) {
        throw new Error('Failed to create Supabase client');
      }

      // Get current user (use getUser() for server-verified auth, not getSession())
      const { data: { user: authUser } } = await supabase.auth.getUser();
      if (!authUser) {
        toast.error('You must be logged in to create a project.');
        setLoading(false);
        return;
      }

      // Create the project (status will be determined by workflow stage)
      const { data: project, error: projectError } = await (supabase as any)
        .from('projects')
        .insert({
          name: formData.name,
          description: formData.description || null,
          account_id: formData.accountId,
          status: 'planning', // Default status, will be updated by workflow
          priority: formData.priority,
          start_date: formData.startDate,
          end_date: formData.endDate,
          estimated_hours: formData.estimatedHours ? parseInt(formData.estimatedHours) : null,
          actual_hours: 0,
          created_by: authUser.id,
        })
        .select()
        .single();

      if (projectError) {
        toast.error('Failed to create project. Please try again.');
        return;
      }

      // Department membership is now automatically derived from user assignments
      // No manual department linking needed

      // Start workflow if one was selected
      if (formData.workflowTemplateId && project) {
        try {
          const workflowResponse = await fetch('/api/workflows/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              projectId: project.id,
              workflowTemplateId: formData.workflowTemplateId,
            }),
          });

          if (!workflowResponse.ok) {
            toast.warning('Project created, but workflow could not be started');
          }
        } catch (error: unknown) {
          toast.warning('Project created, but workflow could not be started');
        }
      }

      toast.success('Project created successfully');
      onProjectCreated?.(project);
      setOpen(false);
      setFormData({
        name: '',
        description: '',
        accountId: '',
        workflowTemplateId: null,
        startDate: new Date().toLocaleDateString('en-CA'),
        endDate: addDays(new Date(), 30).toLocaleDateString('en-CA'),
        priority: 'medium',
        estimatedHours: '',
      });
    } catch (error: unknown) {
      toast.error('An error occurred. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleInputChange = (field: string, value: string | null) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  // Create an account without leaving the dialog (POST /api/accounts checks the permission)
  const createAccount = async () => {
    const name = newAccountName.trim();
    if (!name) {
      setAccountError('Enter the account name.');
      return;
    }
    setAddingAccount(true);
    setAccountError(null);
    try {
      const res = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, status: 'active' }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.account?.id) {
        setAccountError(res.status === 403
          ? "You don't have permission to add accounts. Ask an administrator, or pick an existing account."
          : body.error || 'Could not add the account. Please try again.');
        return;
      }
      const account: Account = { id: body.account.id, name: body.account.name };
      setAccounts(prev => [...prev, account].sort((a, b) => a.name.localeCompare(b.name)));
      handleInputChange('accountId', account.id);
      setNewAccountName('');
      setShowNewAccount(false);
      toast.success(`Account "${account.name}" added`);
    } catch {
      setAccountError('Could not reach the server. Please try again.');
    } finally {
      setAddingAccount(false);
    }
  };

  // What is still needed before the project can be created (shown next to the button)
  const missing = [
    !formData.name.trim() && 'a project name',
    !formData.accountId && 'an account',
    !(parseInt(formData.estimatedHours) > 0) && 'estimated hours',
    formData.startDate && formData.endDate && formData.endDate < formData.startDate && 'an end date after the start date',
  ].filter(Boolean) as string[];
  const noAccounts = accountsLoaded && accounts.length === 0;

  const newAccountForm = (
    <div className="space-y-1.5">
      <div className="flex gap-2">
        <Input
          id="newAccountName"
          aria-label="New account name"
          value={newAccountName}
          onChange={(e) => { setNewAccountName(e.target.value); setAccountError(null); }}
          // Enter adds the account instead of submitting the project form
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); createAccount(); } }}
          placeholder="Account name, e.g. Acme Corp"
          maxLength={200}
          disabled={addingAccount}
        />
        <Button type="button" variant="outline" onClick={createAccount} disabled={addingAccount}>
          {addingAccount ? 'Adding…' : 'Add'}
        </Button>
      </div>
      {accountError && <p role="alert" className="text-xs text-red-600">{accountError}</p>}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {children || (
          <Button>
            <PlusIcon className="h-4 w-4 mr-2" />
            Add Project
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create New Project</DialogTitle>
          <DialogDescription>
            Add a new project to your organization. This will create a project that can be assigned to departments and team members.
          </DialogDescription>
        </DialogHeader>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="name">Project Name *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => handleInputChange('name', e.target.value)}
                placeholder="Enter project name"
                required
                aria-required="true"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="priority">Priority</Label>
              <Select
                value={formData.priority}
                onValueChange={(value) => handleInputChange('priority', value)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="urgent">Urgent</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={formData.description}
              onChange={(e) => handleInputChange('description', e.target.value)}
              placeholder="Enter project description"
              rows={3}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="account">Account *</Label>
              {noAccounts ? (
                <div className="rounded-md border border-dashed p-3 space-y-2">
                  <p className="text-xs text-gray-600">
                    No accounts yet. Every project belongs to an account: the client, or your own company for internal work. Add one here:
                  </p>
                  {newAccountForm}
                </div>
              ) : (
                <>
                  <Select
                    // Remount when an account is added: the closed Radix Select does not pick up a newly
                    // added item, so the just-created account would not show as selected
                    key={accounts.length}
                    value={formData.accountId}
                    onValueChange={(value) => handleInputChange('accountId', value)}
                    required
                    disabled={!accountsLoaded}
                  >
                    <SelectTrigger aria-required="true">
                      <SelectValue placeholder={accountsLoaded ? 'Select an account' : accountsLoadFailed ? "Couldn't load accounts" : 'Loading accounts…'} />
                    </SelectTrigger>
                    <SelectContent>
                      {accounts
                        .filter((account:any) => account && account.id && account.id !== '')
                        .map((account:any) => (
                          <SelectItem key={account.id} value={account.id}>
                            {account.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  {accountsLoaded && (showNewAccount ? newAccountForm : (
                    <button type="button" className="text-xs text-primary underline-offset-4 hover:underline" onClick={() => setShowNewAccount(true)}>
                      + New account
                    </button>
                  ))}
                </>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="workflow">Workflow (Optional)</Label>
              <Select
                value={formData.workflowTemplateId || ''}
                onValueChange={(value) => handleInputChange('workflowTemplateId', value || null)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a workflow" />
                </SelectTrigger>
                <SelectContent>
                  {workflows.length === 0 ? (
                    <SelectItem value="none" disabled>No workflows available</SelectItem>
                  ) : (
                    workflows.map((workflow:any) => (
                      <SelectItem key={workflow.id} value={workflow.id}>
                        {workflow.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              {formData.workflowTemplateId && workflows.find((w: any) => w.id === formData.workflowTemplateId)?.description && (
                <p className="text-xs text-gray-500">
                  {workflows.find((w: any) => w.id === formData.workflowTemplateId)?.description}
                </p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="startDate">Start Date *</Label>
              <Input
                id="startDate"
                type="date"
                value={formData.startDate}
                onChange={(e) => handleInputChange('startDate', e.target.value)}
                required
                aria-required="true"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="endDate">End Date *</Label>
              <Input
                id="endDate"
                type="date"
                value={formData.endDate}
                onChange={(e) => handleInputChange('endDate', e.target.value)}
                required
                aria-required="true"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="estimatedHours">Estimated Hours *</Label>
            <Input
              id="estimatedHours"
              type="number"
              value={formData.estimatedHours}
              onChange={(e) => handleInputChange('estimatedHours', e.target.value)}
              placeholder="Enter estimated hours"
              min="1"
              required
              aria-required="true"
            />
          </div>

          {missing.length > 0 && (
            <p id="project-missing" className="text-xs text-gray-600" aria-live="polite">
              To create the project, add {missing.join(', ')}.
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading || missing.length > 0} aria-describedby={missing.length ? 'project-missing' : undefined}>
              {loading ? 'Creating...' : 'Create Project'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
