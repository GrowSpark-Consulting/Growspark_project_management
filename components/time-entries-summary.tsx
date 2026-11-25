'use client';


import useSWR from 'swr';
import { Card, CardContent } from '@/components/ui/card';
import { Clock, Calendar, TrendingUp, BarChart3 } from 'lucide-react';
import { UserWithRoles } from '@/lib/rbac';
import { myTimeEntrySummary } from '@/lib/client-queries';
import { format, startOfWeek, endOfWeek, startOfMonth, endOfMonth, subDays } from 'date-fns';

interface TimeEntriesSummaryProps {
  userProfile: UserWithRoles;
}

interface SummaryStats {
  hoursThisWeek: number;
  hoursThisMonth: number;
  averageHoursPerDay: number;
  totalEntries: number;
}

export function TimeEntriesSummary({ userProfile }: TimeEntriesSummaryProps) {
  const userId = (userProfile as any).id;

  // Cached by SWR: returning to the page shows the last numbers at once and refreshes them in the background
  const { data, error } = useSWR(['my-time-entry-summary', userId], async (): Promise<SummaryStats> => {
    {
      const now = new Date();
      const weekStart = startOfWeek(now, { weekStartsOn: 1 }); // Monday
      const weekEnd = endOfWeek(now, { weekStartsOn: 1 });
      const monthStart = startOfMonth(now);
      const monthEnd = endOfMonth(now);
      const last30DaysStart = subDays(now, 30);

      // The rows behind the cards; the dates come from the user's own time zone
      const { data: summary } = await myTimeEntrySummary({
        weekFrom: format(weekStart, 'yyyy-MM-dd'),
        weekTo: format(weekEnd, 'yyyy-MM-dd'),
        monthFrom: format(monthStart, 'yyyy-MM-dd'),
        monthTo: format(monthEnd, 'yyyy-MM-dd'),
        since: format(last30DaysStart, 'yyyy-MM-dd'),
      });

      // This week's hours
      const weekData = summary?.week;

      const hoursThisWeek = weekData?.reduce((sum: number, entry: { hours_logged: number }) => sum + (entry.hours_logged || 0), 0) || 0;

      // This month's hours
      const monthData = summary?.month;

      const hoursThisMonth = monthData?.reduce((sum: number, entry: { hours_logged: number }) => sum + (entry.hours_logged || 0), 0) || 0;

      // Last 30 days for the average
      const last30DaysData = summary?.recent;

      // Calculate average hours per day (only counting days with entries)
      const uniqueDays = new Set(last30DaysData?.map((entry: { entry_date: string }) => entry.entry_date) || []);
      const totalHours = last30DaysData?.reduce((sum: number, entry: { hours_logged: number }) => sum + (entry.hours_logged || 0), 0) || 0;
      const averageHoursPerDay = uniqueDays.size > 0 ? totalHours / uniqueDays.size : 0;

      // Total entries count
      const count = summary?.count;

      return {
        hoursThisWeek,
        hoursThisMonth,
        averageHoursPerDay,
        totalEntries: count || 0,
      };
    }
  });
  // A failed load shows zeros (as before) instead of loading forever
  const stats = data ?? (error ? { hoursThisWeek: 0, hoursThisMonth: 0, averageHoursPerDay: 0, totalEntries: 0 } : undefined);

  if (!stats) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="text-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
            <p className="text-sm text-gray-500 mt-2">Loading statistics...</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
      {/* This Week */}
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center space-x-4">
            <div className="flex-shrink-0">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-blue-100">
                <Clock className="w-6 h-6 text-blue-600" />
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-600">This Week</p>
              <p className="text-2xl font-bold text-gray-900">{stats.hoursThisWeek.toFixed(1)}h</p>
              <p className="text-xs text-gray-500 mt-1">Hours logged</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* This Month */}
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center space-x-4">
            <div className="flex-shrink-0">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-green-100">
                <Calendar className="w-6 h-6 text-green-600" />
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-600">This Month</p>
              <p className="text-2xl font-bold text-gray-900">{stats.hoursThisMonth.toFixed(1)}h</p>
              <p className="text-xs text-gray-500 mt-1">Hours logged</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Average Per Day */}
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center space-x-4">
            <div className="flex-shrink-0">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-purple-100">
                <TrendingUp className="w-6 h-6 text-purple-600" />
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-600">Daily Average</p>
              <p className="text-2xl font-bold text-gray-900">{stats.averageHoursPerDay.toFixed(1)}h</p>
              <p className="text-xs text-gray-500 mt-1">Last 30 days</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Total Entries */}
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center space-x-4">
            <div className="flex-shrink-0">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-orange-100">
                <BarChart3 className="w-6 h-6 text-orange-600" />
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-600">Total Entries</p>
              <p className="text-2xl font-bold text-gray-900">{stats.totalEntries}</p>
              <p className="text-xs text-gray-500 mt-1">All time</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
