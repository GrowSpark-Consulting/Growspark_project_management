/**
 * API Route: Admin Time Entries
 * GET - Get all time entries for admin view
 */

import { NextRequest, NextResponse } from 'next/server';
import { createApiSupabaseClient, getUserProfileFromRequest } from '@/lib/supabase-server';
import { hasPermission } from '@/lib/permission-checker';
import { Permission } from '@/lib/permissions';
import { logger } from '@/lib/debug-logger';
import { Prisma } from '@/lib/db/generated/client';
import { withUser, schemaName } from '@/lib/db';
import { wantsPage, readPage, pageInfo } from '@/lib/pagination';

// Type definitions
interface ErrorWithMessage extends Error {
  message: string;
  status?: number;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Totals of every matching entry (not just the page shown), computed by Postgres in one query and run as
 * the signed-in user, so row-level security limits it exactly like the list.
 */
async function summaryOf(userId: string, filters: { from: string; to: string | null; userId: string | null }) {
  const schema = schemaName();
  const table = Prisma.raw(schema ? `"${schema}".time_entries` : 'time_entries');
  const conditions = [Prisma.sql`entry_date >= ${filters.from}::date`];
  if (filters.to) conditions.push(Prisma.sql`entry_date <= ${filters.to}::date`);
  if (filters.userId) conditions.push(Prisma.sql`user_id = ${filters.userId}::uuid`);
  const rows = await withUser(userId, (tx) => tx.$queryRaw<Array<{ entries: number; hours: string | null; users: number; projects: number; auto: number }>>`
    select count(*)::int as entries, coalesce(sum(hours_logged), 0)::text as hours,
           count(distinct user_id)::int as users, count(distinct project_id)::int as projects,
           (count(*) filter (where is_auto_clock_out))::int as auto
    from ${table} where ${Prisma.join(conditions, ' and ')}`);
  const r = rows[0];
  return {
    totalEntries: r?.entries ?? 0,
    totalHours: Math.round(Number(r?.hours ?? 0) * 100) / 100,
    uniqueUsers: r?.users ?? 0,
    uniqueProjects: r?.projects ?? 0,
    autoClockOuts: r?.auto ?? 0,
  };
}

/**
 * GET /api/admin/time-entries
 * Time entries of the whole team for the admin page, newest first.
 * Query params: startDate, endDate (YYYY-MM-DD; default the last 30 days), userId.
 * With page/pageSize (20, 50, 100): one page of rows, `pagination`, and a summary over all matching entries.
 * Without them: every matching entry (as before).
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = createApiSupabaseClient(request);
    if (!supabase) {
      return NextResponse.json(
        { error: 'Database connection not available' },
        { status: 500 }
      );
    }

    const userProfile = await getUserProfileFromRequest(supabase);
    if (!userProfile) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Check for admin permission
    // Phase 9: VIEW_TEAM_TIME_ENTRIES → VIEW_ALL_TIME_ENTRIES
    const canViewTeam = await hasPermission(userProfile, Permission.VIEW_ALL_TIME_ENTRIES, undefined, supabase);
    if (!canViewTeam) {
      return NextResponse.json(
        { error: 'Insufficient permissions to view team time entries' },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(request.url);
    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');
    const userId = searchParams.get('userId');
    if ((startDate && !DATE.test(startDate)) || (endDate && !DATE.test(endDate)) || (userId && !UUID.test(userId))) {
      return NextResponse.json({ error: 'Invalid filter' }, { status: 400 });
    }
    const paged = wantsPage(searchParams);
    const pageRequest = readPage(searchParams);

    // Build query
    let query = supabase
      .from('time_entries')
      .select(`
        *,
        user:user_profiles!user_id (
          id,
          name,
          email
        ),
        project:projects!project_id (
          id,
          name
        ),
        task:tasks!task_id (
          id,
          name
        )
      `, paged ? { count: 'exact' } : undefined)
      .order('entry_date', { ascending: false })
      .order('created_at', { ascending: false })
      .order('id', { ascending: false });

    // Apply filters
    if (startDate) {
      query = query.gte('entry_date', startDate);
    }
    if (endDate) {
      query = query.lte('entry_date', endDate);
    }
    if (userId) {
      query = query.eq('user_id', userId);
    }

    // Default to last 30 days if no date range specified
    let from = startDate;
    if (!startDate && !endDate) {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      from = thirtyDaysAgo.toISOString().split('T')[0];
      query = query.gte('entry_date', from);
    }

    if (paged) {
      const [{ data: rows, error: pageError, count }, summary] = await Promise.all([
        query.range(pageRequest.from, pageRequest.to),
        summaryOf(userProfile.id, { from: from || '0001-01-01', to: endDate, userId }),
      ]);
      if (pageError) {
        logger.error('Error fetching time entries', {}, pageError as unknown as Error);
        return NextResponse.json({ error: 'Failed to fetch time entries' }, { status: 500 });
      }
      return NextResponse.json({
        success: true,
        timeEntries: rows || [],
        summary,
        pagination: pageInfo(pageRequest, count || 0),
      });
    }

    const { data: timeEntries, error } = await query;

    if (error) {
      logger.error('Error fetching time entries', {}, error as unknown as Error);
      return NextResponse.json(
        { error: 'Failed to fetch time entries' },
        { status: 500 }
      );
    }

    // Calculate summary stats
    const totalHours = timeEntries?.reduce((sum, entry) => sum + (entry.hours_logged || 0), 0) || 0;
    const uniqueUsers = new Set(timeEntries?.map((e: any) => e.user_id)).size;
    const uniqueProjects = new Set(timeEntries?.map((e: any) => e.project_id)).size;
    const autoClockOuts = timeEntries?.filter((e: any) => e.is_auto_clock_out).length || 0;

    return NextResponse.json({
      success: true,
      timeEntries: timeEntries || [],
      summary: {
        totalEntries: timeEntries?.length || 0,
        totalHours: Math.round(totalHours * 100) / 100,
        uniqueUsers,
        uniqueProjects,
        autoClockOuts
      }
    });
  } catch (error: unknown) {
    const err = error as ErrorWithMessage;
logger.error('Error in GET /api/admin/time-entries', {}, error as Error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
