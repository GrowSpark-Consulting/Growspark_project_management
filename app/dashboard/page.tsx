'use client'

import { useAuth } from '@/lib/hooks/useAuth'
import { useState, Suspense } from 'react'
import { RoleGuard } from "@/components/role-guard"
import { MyWorkSummary } from '@/components/dashboard/my-work-summary'
import { Skeleton } from "@/components/ui/skeleton"
import dynamic from 'next/dynamic'
import useSWR from 'swr'
import Masonry from 'react-masonry-css'

// Loading skeleton for components
const ComponentSkeleton = () => (
  <div className="space-y-3">
    <Skeleton className="h-8 w-full" />
    <Skeleton className="h-32 w-full" />
    <Skeleton className="h-8 w-full" />
  </div>
)

// Code Splitting with dynamic imports
const CapacityDashboard = dynamic(() => import('@/components/capacity-dashboard'), {
  loading: () => <ComponentSkeleton />,
  ssr: false
})
const UnifiedProjectsSection = dynamic(
  () => import('@/components/unified-projects-section').then(mod => mod.UnifiedProjectsSection),
  { loading: () => <ComponentSkeleton />, ssr: false }
)
const MyTimeWidget = dynamic(
  () => import('@/components/dashboard/my-time-widget'),
  { loading: () => <ComponentSkeleton />, ssr: false }
)
const MyTasksWidget = dynamic(
  () => import('@/components/dashboard/my-tasks-widget'),
  { loading: () => <ComponentSkeleton />, ssr: false }
)
const MyWorkflowsWidget = dynamic(
  () => import('@/components/dashboard/my-workflows-widget'),
  { loading: () => <ComponentSkeleton />, ssr: false }
)
const MyAccountsWidget = dynamic(
  () => import('@/components/dashboard/my-accounts-widget'),
  { loading: () => <ComponentSkeleton />, ssr: false }
)
const MyCollaboratorsWidget = dynamic(
  () => import('@/components/dashboard/my-collaborators-widget'),
  { loading: () => <ComponentSkeleton />, ssr: false }
)
const TimeByProjectWidget = dynamic(
  () => import('@/components/dashboard/time-by-project-widget'),
  { loading: () => <ComponentSkeleton />, ssr: false }
)
const TaskCompletionTrendWidget = dynamic(
  () => import('@/components/dashboard/task-completion-trend-widget'),
  { loading: () => <ComponentSkeleton />, ssr: false }
)
const UpcomingDeadlinesWidget = dynamic(
  () => import('@/components/dashboard/upcoming-deadlines-widget'),
  { loading: () => <ComponentSkeleton />, ssr: false }
)
const RecentActivityWidget = dynamic(
  () => import('@/components/dashboard/recent-activity-widget'),
  { loading: () => <ComponentSkeleton />, ssr: false }
)

// Types
interface MyAnalyticsData {
  time: {
    hoursToday: number;
    hoursThisWeek: number;
    hoursThisMonth: number;
    weeklyTarget: number;
    dailyAverage: number;
  };
  tasks: {
    inProgress: number;
    dueThisWeek: number;
    overdue: number;
    completedThisWeek: number;
    urgent: { id: string; name: string; projectId: string; projectName: string; dueDate: string; status: string }[];
  };
}

// Widget types - full-width widgets render separately, others go in masonry grid
const FULL_WIDTH_WIDGETS = new Set(['projects', 'capacity', 'activity']);

// Masonry breakpoints: { screenWidth: numberOfColumns }
// Desktop: 4 columns, Tablet: 2-3 columns, Mobile: 1 column
const MASONRY_BREAKPOINTS = {
  default: 4,  // 4 columns on large screens
  1200: 3,     // 3 columns at 1200px and below
  900: 2,      // 2 columns at 900px and below
  600: 1,      // 1 column at 600px and below (mobile)
};

// The dashboard layout: full-width widgets on their own row, the others in a masonry grid between them
const RENDER_GROUPS: { type: 'full-width' | 'masonry'; widgets: string[] }[] = [];
for (const type of [
  'projects', 'capacity', 'time', 'tasks', 'workflows',
  'accounts', 'collaborators', 'time-by-project', 'task-trend',
  'deadlines', 'activity',
]) {
  const last = RENDER_GROUPS[RENDER_GROUPS.length - 1];
  if (FULL_WIDTH_WIDGETS.has(type)) RENDER_GROUPS.push({ type: 'full-width', widgets: [type] });
  else if (last?.type === 'masonry') last.widgets.push(type);
  else RENDER_GROUPS.push({ type: 'masonry', widgets: [type] });
}

const fetcher = (url: string) => fetch(url).then(res => res.json());

export default function DashboardPage() {
  const { userProfile } = useAuth()
  const [capacityRefreshKey, _setCapacityRefreshKey] = useState(0)

  // Fetch analytics data for widgets
  const { data: analyticsData, isLoading: analyticsLoading } = useSWR<{ success: boolean; data: MyAnalyticsData }>(
    '/api/dashboard/my-analytics',
    fetcher,
    {
      revalidateOnFocus: false,
      dedupingInterval: 30000,
    }
  )

  const analytics = analyticsData?.data

  // Get user's first name for greeting
  const firstName = (userProfile as any)?.name?.split(' ')[0] || 'there'

  // Render a widget by type
  const renderWidget = (type: string) => {
    switch (type) {
      case 'projects':
        return (
          <Suspense key={type} fallback={<ComponentSkeleton />}>
            <UnifiedProjectsSection userProfile={userProfile as any} />
          </Suspense>
        );
      case 'capacity':
        return userProfile ? (
          <Suspense key={type} fallback={<ComponentSkeleton />}>
            <CapacityDashboard key={capacityRefreshKey} userProfile={userProfile} />
          </Suspense>
        ) : null;
      case 'activity':
        return (
          <Suspense key={type} fallback={<ComponentSkeleton />}>
            <RecentActivityWidget />
          </Suspense>
        );
      case 'time':
        return (
          <Suspense key={type} fallback={<ComponentSkeleton />}>
            <MyTimeWidget data={analytics?.time || null} isLoading={analyticsLoading} />
          </Suspense>
        );
      case 'tasks':
        return (
          <Suspense key={type} fallback={<ComponentSkeleton />}>
            <MyTasksWidget data={analytics?.tasks || null} isLoading={analyticsLoading} />
          </Suspense>
        );
      case 'workflows':
        return (
          <Suspense key={type} fallback={<ComponentSkeleton />}>
            <MyWorkflowsWidget />
          </Suspense>
        );
      case 'accounts':
        return (
          <Suspense key={type} fallback={<ComponentSkeleton />}>
            <MyAccountsWidget />
          </Suspense>
        );
      case 'collaborators':
        return (
          <Suspense key={type} fallback={<ComponentSkeleton />}>
            <MyCollaboratorsWidget />
          </Suspense>
        );
      case 'time-by-project':
        return (
          <Suspense key={type} fallback={<ComponentSkeleton />}>
            <TimeByProjectWidget />
          </Suspense>
        );
      case 'task-trend':
        return (
          <Suspense key={type} fallback={<ComponentSkeleton />}>
            <TaskCompletionTrendWidget />
          </Suspense>
        );
      case 'deadlines':
        return (
          <Suspense key={type} fallback={<ComponentSkeleton />}>
            <UpcomingDeadlinesWidget />
          </Suspense>
        );
      default:
        return null;
    }
  };

  return (
    <RoleGuard>
      <div className="space-y-4">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            Welcome back, {firstName}
          </h1>
          <p className="text-muted-foreground text-sm">
            Here&apos;s what&apos;s happening with your projects
          </p>
        </div>

        {/* My Work summary: today's deadlines, overdue, review status, hours, notifications */}
        <MyWorkSummary />

        {RENDER_GROUPS.map((group, groupIndex) => (
          group.type === 'full-width' ? (
            <section key={`full-${groupIndex}`}>
              {renderWidget(group.widgets[0])}
            </section>
          ) : (
            <Masonry
              key={`masonry-${groupIndex}`}
              breakpointCols={MASONRY_BREAKPOINTS}
              className="masonry-grid"
              columnClassName="masonry-grid-column"
            >
              {group.widgets.map(type => (
                <div key={type} className="mb-4">
                  {renderWidget(type)}
                </div>
              ))}
            </Masonry>
          )
        ))}
      </div>
    </RoleGuard>
  )
}
