'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { SidebarBrand } from '@/components/brand-chip';
import { useAuth } from '@/lib/hooks/useAuth';
import { cn } from '@/lib/utils';
import { isSuperadmin, isUnassigned } from '@/lib/rbac';
import { Permission } from '@/lib/permissions';
import {
  computeUserPermissions,
  hasPermissionSync,
  hasAnyPermissionSync,
  ComputedPermissions
} from '@/lib/permission-utils';
import { profileDepartments } from '@/lib/department-membership';
import {
  LayoutDashboard,
  Building2,
  Users,
  User,
  UserPlus,
  Settings,
  GitBranch,
  Shield,
  Clock,
  BarChart3,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  ListChecks,
  CalendarDays,
  ClipboardCheck,
  Trophy,
  BriefcaseBusiness,
  Inbox,
  LayoutTemplate,
  FileBarChart,
} from 'lucide-react';
import { isManagerProfile, profilePermissions } from '@/lib/portal';

const managerMenuItems = [
  { name: 'Manager Overview', href: '/manager', icon: BriefcaseBusiness },
  { name: 'Team & Workload', href: '/manager/team', icon: Users },
  { name: 'Team Timesheets', href: '/manager/timesheets', icon: ClipboardCheck },
  { name: 'Approvals', href: '/manager/approvals', icon: Inbox },
  { name: 'Reports', href: '/manager/reports', icon: FileBarChart },
  { name: 'Templates', href: '/manager/templates', icon: LayoutTemplate },
];
import { SidebarItem, sidebarItemClass } from './sidebar-item';
import { SidebarSection } from './sidebar-section';
import { SidebarUserProfile } from './sidebar-user-profile';
import { SidebarClockWidget } from './sidebar-clock-widget';
import { useClockWidgetState } from '@/lib/hooks/use-clock-widget-state';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';

interface NavigationItem {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  permission?: Permission;
  anyPermission?: Permission[];
  allowUnassigned?: boolean;
}

interface AdminMenuItem {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  anyPermission: Permission[];
}

const navigationItems: NavigationItem[] = [
  {
    name: 'Welcome',
    href: '/welcome',
    icon: User,
    allowUnassigned: true,
  },
  {
    name: 'Dashboard',
    href: '/dashboard',
    icon: LayoutDashboard,
    anyPermission: [Permission.VIEW_PROJECTS, Permission.VIEW_ACCOUNTS, Permission.VIEW_DEPARTMENTS],
    allowUnassigned: false,
  },
  {
    name: 'Department',
    href: '/departments',
    icon: Building2,
    anyPermission: [Permission.VIEW_DEPARTMENTS, Permission.VIEW_ALL_DEPARTMENTS],
    allowUnassigned: false,
  },
  {
    name: 'Projects',
    href: '/projects',
    icon: FolderOpen,
    anyPermission: [Permission.VIEW_PROJECTS, Permission.VIEW_ALL_PROJECTS],
    allowUnassigned: false,
  },
  {
    name: 'My Tasks',
    href: '/tasks',
    icon: ListChecks,
    anyPermission: [Permission.VIEW_PROJECTS, Permission.VIEW_ALL_PROJECTS, Permission.MANAGE_TIME],
    allowUnassigned: false,
  },
  {
    name: 'Calendar',
    href: '/calendar',
    icon: CalendarDays,
    anyPermission: [Permission.VIEW_PROJECTS, Permission.VIEW_ALL_PROJECTS, Permission.MANAGE_TIME],
    allowUnassigned: false,
  },
  {
    name: 'Timesheets',
    href: '/timesheets',
    icon: ClipboardCheck,
    anyPermission: [Permission.MANAGE_TIME],
    allowUnassigned: false,
  },
  {
    name: 'My Performance',
    href: '/performance',
    icon: Trophy,
    anyPermission: [Permission.VIEW_PROJECTS, Permission.VIEW_ALL_PROJECTS, Permission.MANAGE_TIME],
    allowUnassigned: false,
  },
  {
    name: 'Accounts',
    href: '/accounts',
    icon: Users,
    anyPermission: [Permission.VIEW_ACCOUNTS, Permission.VIEW_ALL_ACCOUNTS],
    allowUnassigned: false,
  },
  {
    name: 'Time Entries',
    href: '/time-entries',
    icon: Clock,
    anyPermission: [Permission.MANAGE_TIME, Permission.VIEW_TIME_ENTRIES, Permission.VIEW_ALL_TIME_ENTRIES],
    allowUnassigned: false,
  },
];

const adminMenuItems: AdminMenuItem[] = [
  {
    name: 'Admin Dashboard',
    href: '/admin',
    icon: Settings,
    anyPermission: [
      Permission.MANAGE_USER_ROLES,
      Permission.MANAGE_USERS,
      Permission.MANAGE_DEPARTMENTS,
      Permission.MANAGE_ACCOUNTS,
    ],
  },
  {
    name: 'Workflows',
    href: '/admin/workflows',
    icon: GitBranch,
    anyPermission: [Permission.MANAGE_WORKFLOWS, Permission.MANAGE_ALL_WORKFLOWS],
  },
  {
    name: 'User Management',
    href: '/admin/roles',
    icon: Shield,
    anyPermission: [Permission.MANAGE_USER_ROLES, Permission.MANAGE_USERS],
  },
  {
    name: 'Invite Users',
    href: '/admin/invitations',
    icon: UserPlus,
    anyPermission: [Permission.MANAGE_USER_ROLES],
  },
  {
    name: 'Users',
    href: '/admin/users',
    icon: Users,
    anyPermission: [Permission.MANAGE_USERS, Permission.MANAGE_USER_ROLES],
  },
  {
    name: 'Company Settings',
    href: '/admin/settings',
    icon: Settings,
    anyPermission: [], // superadmin only (superadmins see every admin item)
  },
  {
    name: 'Time Tracking',
    href: '/admin/time-tracking',
    icon: Clock,
    anyPermission: [Permission.VIEW_ALL_TIME_ENTRIES],
  },
  {
    name: 'Analytics',
    href: '/analytics',
    icon: BarChart3,
    anyPermission: [
      Permission.VIEW_ALL_ANALYTICS,
      Permission.VIEW_ALL_DEPARTMENT_ANALYTICS,
      Permission.VIEW_ALL_ACCOUNT_ANALYTICS,
    ],
  },
];

export function SidebarNavigation() {
  const [isMounted, setIsMounted] = useState(false);
  const [visibleItems, setVisibleItems] = useState<NavigationItem[]>(
    navigationItems.filter((item) => item.allowUnassigned === true)
  );
  const [permissionsChecked, setPermissionsChecked] = useState(false);
  const [visibleAdminItems, setVisibleAdminItems] = useState<AdminMenuItem[]>([]);
  const [deptExpanded, setDeptExpanded] = useState(false);
  const { userProfile, loading } = useAuth();
  const pathname = usePathname();
  const { isDocked, popOut, isHydrated: clockHydrated } = useClockWidgetState();

  // Handle hydration
  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Get user departments
  // Departments through the user's roles or added directly (department_members)
  const getUserDepartments = () => profileDepartments(userProfile as never);

  // Check permissions for navigation items
  useEffect(() => {
    if (!isMounted || loading || !userProfile) {
      setVisibleItems(navigationItems.filter((item) => item.allowUnassigned === true));
      setPermissionsChecked(false);
      setVisibleAdminItems([]);
      return;
    }

    function filterItemsSync() {
      setPermissionsChecked(false);

      const isActuallyUnassigned = isUnassigned(userProfile);
      const userIsSuperadmin = isSuperadmin(userProfile);

      if (userIsSuperadmin) {
        setVisibleItems(navigationItems);
        setVisibleAdminItems(adminMenuItems);
        setPermissionsChecked(true);
        return;
      }

      if (isActuallyUnassigned) {
        const allowedItems = navigationItems.filter((item) => item.allowUnassigned === true);
        setVisibleItems(allowedItems);
        setVisibleAdminItems([]);
        setPermissionsChecked(true);
        return;
      }

      const computed: ComputedPermissions = computeUserPermissions(userProfile);

      const filtered: NavigationItem[] = [];
      for (const item of navigationItems) {
        if (!item.permission && (!item.anyPermission || item.anyPermission.length === 0)) {
          if (item.allowUnassigned === true) {
            filtered.push(item);
          }
          continue;
        }

        if (item.permission) {
          if (hasPermissionSync(computed, item.permission)) {
            filtered.push(item);
            continue;
          }
        }

        if (item.anyPermission && item.anyPermission.length > 0) {
          if (hasAnyPermissionSync(computed, item.anyPermission)) {
            filtered.push(item);
          }
        }
      }

      if (filtered.length === 0) {
        const welcomeItem = navigationItems.find((item) => item.allowUnassigned === true);
        if (welcomeItem) {
          filtered.push(welcomeItem);
        }
      }

      const filteredAdminItems: AdminMenuItem[] = [];
      for (const adminItem of adminMenuItems) {
        if (hasAnyPermissionSync(computed, adminItem.anyPermission)) {
          filteredAdminItems.push(adminItem);
        }
      }

      setVisibleItems(filtered);
      setVisibleAdminItems(filteredAdminItems);
      setPermissionsChecked(true);
    }

    try {
      filterItemsSync();
    } catch {
      setVisibleItems(navigationItems.filter((item) => item.allowUnassigned === true));
      setVisibleAdminItems([]);
      setPermissionsChecked(true);
    }
  }, [isMounted, loading, userProfile]);

  // Auto-expand department section if on department page
  useEffect(() => {
    if (pathname.startsWith('/departments')) {
      setDeptExpanded(true);
    }
  }, [pathname]);

  const userDepartments = getUserDepartments();
  const hasDepartmentItem = visibleItems.some(item => item.name === 'Department');

  // Loading state
  if (!isMounted) {
    return (
      <aside className="w-60 flex-shrink-0 bg-[var(--sidebar)] flex flex-col h-screen">
        <div className="h-14 px-5 flex items-center">
          <SidebarBrand />
        </div>
        <div className="flex-1 p-2 space-y-1">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-9 bg-[var(--sidebar-active-bg)] rounded animate-pulse" />
          ))}
        </div>
        <div className="p-3 border-t border-[var(--sidebar-border)]">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-[var(--sidebar-active-bg)] animate-pulse" />
            <div className="flex-1">
              <div className="h-3 w-20 bg-[var(--sidebar-active-bg)] rounded animate-pulse mb-1" />
              <div className="h-2.5 w-14 bg-[var(--sidebar-active-bg)] rounded animate-pulse" />
            </div>
          </div>
        </div>
      </aside>
    );
  }

  return (
    <aside aria-label="Sidebar" className="w-60 flex-shrink-0 bg-[var(--sidebar)] text-[var(--on-sidebar)] flex flex-col h-screen">
      {/* Product header: chip + name (matches the 56px top bar) */}
      <div className="h-14 px-5 flex items-center">
        <Link
          href={userProfile?.user_roles && userProfile.user_roles.length > 0 ? '/dashboard' : '/welcome'}
          className="flex min-w-0 items-center rounded-md focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
        >
          <SidebarBrand />
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 pb-4" role="navigation" aria-label="Main navigation">
        {/* Main Section */}
        <SidebarSection title="Main">
          {(!permissionsChecked ? navigationItems.filter(item => item.allowUnassigned) : visibleItems).map((item) => {
            // Special handling for Department with expandable sub-items
            if (item.name === 'Department' && hasDepartmentItem) {
              const isDeptActive = pathname.startsWith('/departments');

              return (
                <Collapsible
                  key={item.name}
                  open={deptExpanded}
                  onOpenChange={setDeptExpanded}
                >
                  <CollapsibleTrigger asChild>
                    <button
                      className={cn('w-full', sidebarItemClass(isDeptActive))}
                      aria-expanded={deptExpanded}
                      aria-current={isDeptActive ? 'page' : undefined}
                    >
                      <Building2 className="h-[18px] w-[18px] flex-shrink-0 opacity-85" strokeWidth={1.75} />
                      <span className="truncate flex-1 text-left">Department</span>
                      {deptExpanded ? (
                        <ChevronDown className="h-4 w-4 flex-shrink-0" />
                      ) : (
                        <ChevronRight className="h-4 w-4 flex-shrink-0" />
                      )}
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="ml-4 mt-1 space-y-0.5 border-l border-[var(--sidebar-active)] pl-3">
                      <Link
                        href="/departments"
                        aria-current={pathname === '/departments' ? 'page' : undefined}
                        className={cn(
                          'flex items-center gap-2 px-2 py-1.5 text-[13px] rounded-md transition-colors',
                          pathname === '/departments'
                            ? 'text-[var(--on-sidebar)] font-medium bg-[var(--sidebar-active)]'
                            : 'text-[var(--on-sidebar-muted)] hover:text-[var(--on-sidebar)] hover:bg-[var(--sidebar-active)]'
                        )}
                      >
                        All Departments
                      </Link>
                      {userDepartments.map((dept) => (
                        <Link
                          key={dept.id}
                          href={`/departments/${dept.id}`}
                          aria-current={pathname === `/departments/${dept.id}` ? 'page' : undefined}
                          className={cn(
                            'flex items-center gap-2 px-2 py-1.5 text-[13px] rounded-md transition-colors',
                            pathname === `/departments/${dept.id}`
                              ? 'text-[var(--on-sidebar)] font-medium bg-[var(--sidebar-active)]'
                              : 'text-[var(--on-sidebar-muted)] hover:text-[var(--on-sidebar)] hover:bg-[var(--sidebar-active)]'
                          )}
                        >
                          {dept.name}
                        </Link>
                      ))}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              );
            }

            // Skip Welcome item in main section if user has roles
            if (item.name === 'Welcome' && userProfile?.user_roles && userProfile.user_roles.length > 0) {
              return null;
            }

            return (
              <SidebarItem
                key={item.name}
                href={item.href}
                label={item.name}
                icon={item.icon as any}
              />
            );
          })}
        </SidebarSection>

        {/* Manager Section - superadmin, manage_projects, manage_all_projects, approve_timesheets, view_all_projects */}
        {permissionsChecked && userProfile && (isManagerProfile(userProfile as any) || profilePermissions(userProfile as any).has('view_all_projects')) && (
          <SidebarSection title="Manager" className="mt-4">
            {managerMenuItems.map((item) => (
              <SidebarItem key={item.href} href={item.href} label={item.name} icon={item.icon as any} exactMatch={item.href === '/manager'} />
            ))}
          </SidebarSection>
        )}

        {/* Admin Section - only show if user has admin permissions */}
        {visibleAdminItems.length > 0 && (
          <SidebarSection title="Administration" className="mt-4">
            {visibleAdminItems.map((item) => (
              <SidebarItem
                key={item.href}
                href={item.href}
                label={item.name}
                icon={item.icon as any}
                exactMatch={item.href === '/admin'}
              />
            ))}
          </SidebarSection>
        )}
      </nav>

      {/* Clock Widget (when docked) */}
      {clockHydrated && isDocked && (
        <SidebarClockWidget onPopOut={popOut} />
      )}

      {/* User Profile */}
      <SidebarUserProfile
        userProfile={userProfile as any}
        isLoading={loading}
      />
    </aside>
  );
}
