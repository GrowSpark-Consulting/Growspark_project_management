'use client';


import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { UserWithRoles } from '@/lib/rbac';
import { myTimeEntries } from '@/lib/client-queries';
import { format, subDays, parseISO } from 'date-fns';
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

interface TimeEntriesChartProps {
  userProfile: UserWithRoles;
}

interface DailyData {
  date: string;
  hours: number;
}

interface ProjectData {
  name: string;
  hours: number;
  color: string;
  [key: string]: string | number;
}

// Brand colors - blue primary + gray variants
const COLORS = [
  'var(--data-3)', // accent blue (primary)
  'var(--ink-muted)', // gray
  'var(--ink-muted)', // gray
  'var(--data-2)', // gray
  'var(--ink)', // gray
  'var(--ink-muted)', // gray
  'var(--data-1)', // olive (for variety)
  'var(--ink)', // dark gray
];

export function TimeEntriesChart({ userProfile }: TimeEntriesChartProps) {
  const [dailyData, setDailyData] = useState<DailyData[]>([]);
  const [projectData, setProjectData] = useState<ProjectData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const fetchChartData = async () => {
      setLoading(true);
      try {
        const thirtyDaysAgo = subDays(new Date(), 30);
        const startDate = format(thirtyDaysAgo, 'yyyy-MM-dd');
        const endDate = format(new Date(), 'yyyy-MM-dd');

        // The signed-in user's entries for the last 30 days
        const { data: entries } = await myTimeEntries({ from: startDate, to: endDate, sort: 'entry_date', order: 'asc' });

        if (cancelled) return;
        if (!entries) return;

        // Process daily data
        const dailyMap = new Map<string, number>();

        // Initialize all days with 0 hours
        for (let i = 0; i <= 30; i++) {
          const date = subDays(new Date(), 30 - i);
          const dateStr = format(date, 'yyyy-MM-dd');
          dailyMap.set(dateStr, 0);
        }

        // Aggregate hours by day
        entries.forEach((entry: { entry_date: string; hours_logged: number }) => {
          const currentHours = dailyMap.get(entry.entry_date) || 0;
          dailyMap.set(entry.entry_date, currentHours + (entry.hours_logged || 0));
        });

        // Convert to array for chart
        const dailyArray: DailyData[] = Array.from(dailyMap.entries()).map(([date, hours]) => ({
          date: format(parseISO(date), 'MMM dd'),
          hours: parseFloat(hours.toFixed(1)),
        }));

        if (cancelled) return;
        setDailyData(dailyArray);

        // Process project data
        const projectMap = new Map<string, { name: string; hours: number }>();

        entries.forEach((entry: { project_id?: string; hours_logged: number; projects?: { name: string } }) => {
          const projectId = entry.project_id || 'unknown';
          const projectName = entry.projects?.name || 'No Project';

          const existing = projectMap.get(projectId);
          if (existing) {
            existing.hours += entry.hours_logged || 0;
          } else {
            projectMap.set(projectId, {
              name: projectName,
              hours: entry.hours_logged || 0,
            });
          }
        });

        // Convert to array and sort by hours (descending)
        const projectArray: ProjectData[] = Array.from(projectMap.values())
          .map((project:any, index:any) => ({
            name: project.name,
            hours: parseFloat(project.hours.toFixed(1)),
            color: COLORS[index % COLORS.length],
          }))
          .sort((a, b) => b.hours - a.hours);

        if (cancelled) return;
        setProjectData(projectArray);

      } catch (error: unknown) {
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchChartData();

    return () => {
      cancelled = true;
    };
  }, [userProfile]);

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="text-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--primary)] mx-auto"></div>
            <p className="text-sm text-gray-500 mt-2">Loading charts...</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const totalHours = projectData.reduce((sum, project) => sum + project.hours, 0);

  return (
    <div className="space-y-6">
      {/* Daily Trend Chart */}
      <Card>
        <CardHeader>
          <CardTitle>Daily Time Trend</CardTitle>
          <CardDescription>Hours logged per day (last 30 days)</CardDescription>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={dailyData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 12 }}
                interval="preserveStartEnd"
              />
              <YAxis
                label={{ value: 'Hours', angle: -90, position: 'insideLeft' }}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'white',
                  border: '1px solid var(--line)',
                  borderRadius: '6px',
                }}
              />
              <Line
                type="monotone"
                dataKey="hours"
                stroke="var(--data-3)"
                strokeWidth={2}
                dot={{ fill: 'var(--data-3)', r: 4 }}
                activeDot={{ r: 6 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Project Hours Bar Chart */}
        <Card>
          <CardHeader>
            <CardTitle>Hours by Project</CardTitle>
            <CardDescription>Total hours per project (last 30 days)</CardDescription>
          </CardHeader>
          <CardContent>
            {projectData.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={projectData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis
                    dataKey="name"
                    tick={{ fontSize: 11 }}
                    interval={0}
                    angle={-45}
                    textAnchor="end"
                    height={100}
                  />
                  <YAxis
                    label={{ value: 'Hours', angle: -90, position: 'insideLeft' }}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'white',
                      border: '1px solid var(--line)',
                      borderRadius: '6px',
                    }}
                  />
                  <Bar dataKey="hours" radius={[8, 8, 0, 0]}>
                    {projectData.map((entry:any, index:any) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="text-center py-12 text-gray-500">
                No project data available
              </div>
            )}
          </CardContent>
        </Card>

        {/* Project Distribution Pie Chart */}
        <Card>
          <CardHeader>
            <CardTitle>Project Distribution</CardTitle>
            <CardDescription>
              Percentage breakdown ({totalHours.toFixed(1)} total hours)
            </CardDescription>
          </CardHeader>
          <CardContent>
            {projectData.length > 0 ? (
              <div className="flex flex-col items-center">
                <ResponsiveContainer width="100%" height={250}>
                  <PieChart>
                    <Pie
                      data={projectData}
                      cx="50%"
                      cy="50%"
                      labelLine={false}
                      label={({ name, percent }) =>
                        `${name}: ${((percent || 0) * 100).toFixed(0)}%`
                      }
                      outerRadius={80}
                      fill="var(--data-5)"
                      dataKey="hours"
                    >
                      {projectData.map((entry:any, index:any) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        backgroundColor: 'white',
                        border: '1px solid var(--line)',
                        borderRadius: '6px',
                      }}
                      formatter={(value: number) => `${value.toFixed(1)} hours`}
                    />
                  </PieChart>
                </ResponsiveContainer>

                {/* Legend */}
                <div className="mt-4 grid grid-cols-2 gap-2 w-full">
                  {projectData.map((project:any, index:any) => (
                    <div key={index} className="flex items-center gap-2 text-sm">
                      <div
                        className="w-3 h-3 rounded-full flex-shrink-0"
                        style={{ backgroundColor: project.color }}
                      />
                      <span className="truncate">{project.name}</span>
                      <span className="text-gray-500 ml-auto">
                        {project.hours}h
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="text-center py-12 text-gray-500">
                No project data available
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Summary Stats */}
      <Card>
        <CardHeader>
          <CardTitle>Insights</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="p-4 bg-[var(--primary)]/10 dark:bg-[var(--primary)]/20 rounded-lg">
              <p className="text-sm font-medium text-[var(--ink-muted)] dark:text-[var(--ink-muted)]">Most Active Project</p>
              <p className="text-2xl font-bold text-[var(--primary)] mt-1">
                {projectData.length > 0 ? projectData[0].name : 'N/A'}
              </p>
              <p className="text-xs text-[var(--ink-muted)] mt-1">
                {projectData.length > 0 ? `${projectData[0].hours} hours` : ''}
              </p>
            </div>

            <div className="p-4 bg-[var(--success)]/10 dark:bg-[var(--success)]/20 rounded-lg">
              <p className="text-sm font-medium text-[var(--ink-muted)] dark:text-[var(--ink-muted)]">Total Projects</p>
              <p className="text-2xl font-bold text-[var(--success)] dark:text-[var(--success)] mt-1">
                {projectData.length}
              </p>
              <p className="text-xs text-[var(--ink-muted)] mt-1">Last 30 days</p>
            </div>

            <div className="p-4 bg-[var(--ink-muted)]/10 dark:bg-[var(--ink-muted)]/20 rounded-lg">
              <p className="text-sm font-medium text-[var(--ink-muted)] dark:text-[var(--ink-muted)]">Average Daily Hours</p>
              <p className="text-2xl font-bold text-[var(--ink-muted)] mt-1">
                {(() => {
                  const activeDays = dailyData.filter(d => d.hours > 0).length;
                  return activeDays > 0 ? (totalHours / activeDays).toFixed(1) : '0.0';
                })()}
              </p>
              <p className="text-xs text-[var(--ink-muted)] mt-1">Per active work day (last 30 days)</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
