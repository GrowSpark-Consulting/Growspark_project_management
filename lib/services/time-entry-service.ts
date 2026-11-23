/**
 * Time Entry Service
 * Manages time logging on tasks and projects
 */


import { logger } from '../debug-logger';

type TimeEntry = any;
type TimeEntryInsert = any;
type TimeEntryUpdate = any;

export interface TimeEntryWithDetails extends TimeEntry {
  task?: {
    id: string;
    name: string;
  };
  project?: {
    id: string;
    name: string;
  };
  user?: {
    id: string;
    name: string;
    email: string;
  };
}

class TimeEntryService {
  /**
   * Get Monday of the week for a given date
   */
  getWeekStartDate(date: Date = new Date()): string {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(d.setDate(diff));
    return monday.toISOString().split('T')[0];
  }

  /**
   * Get time entries for a user
   */
  async getUserTimeEntries(
    userId: string,
    startDate?: string,
    endDate?: string,
    db?: any
  ): Promise<TimeEntryWithDetails[]> {
    const supabase = db;
    if (!supabase) return [];

    let query = supabase
      .from('time_entries')
      .select(`
        *,
        task:tasks(id, name),
        project:projects(id, name),
        user:user_profiles(id, name, email)
      `)
      .eq('user_id', userId)
      .order('entry_date', { ascending: false });

    if (startDate) {
      query = query.gte('entry_date', startDate);
    }

    if (endDate) {
      query = query.lte('entry_date', endDate);
    }

    const { data, error } = await query;

    if (error) {
      logger.error('Error fetching user time entries', {}, error as Error);
      return [];
    }

    return (data as unknown as TimeEntryWithDetails[]) || [];
  }

  /**
   * Get time entries for a task
   */
  async getTaskTimeEntries(taskId: string, db?: any): Promise<TimeEntryWithDetails[]> {
    const supabase = db;
    if (!supabase) return [];

    const { data, error } = await supabase
      .from('time_entries')
      .select(`
        *,
        task:tasks(id, name),
        project:projects(id, name),
        user:user_profiles(id, name, email)
      `)
      .eq('task_id', taskId)
      .order('entry_date', { ascending: false });

    if (error) {
      logger.error('Error fetching task time entries', {}, error as Error);
      return [];
    }

    return (data as unknown as TimeEntryWithDetails[]) || [];
  }

  /**
   * Get time entries for a project
   */
  async getProjectTimeEntries(
    projectId: string,
    weekStartDate?: string,
    db?: any
  ): Promise<TimeEntryWithDetails[]> {
    const supabase = db;
    if (!supabase) return [];

    let query = supabase
      .from('time_entries')
      .select(`
        *,
        task:tasks(id, name),
        project:projects(id, name),
        user:user_profiles(id, name, email)
      `)
      .eq('project_id', projectId)
      .order('entry_date', { ascending: false });

    if (weekStartDate) {
      query = query.eq('week_start_date', weekStartDate);
    }

    const { data, error } = await query;

    if (error) {
      logger.error('Error fetching project time entries', {}, error as Error);
      return [];
    }

    return (data as unknown as TimeEntryWithDetails[]) || [];
  }

  /**
   * Update a time entry
   */
  async updateTimeEntry(
    entryId: string,
    updates: {
      hours_logged?: number;
      entry_date?: string;
      description?: string;
    },
    db?: any
  ): Promise<TimeEntry | null> {
    const supabase = db;
    if (!supabase) return null;

    const updateData: TimeEntryUpdate = {};

    if (updates.hours_logged !== undefined) {
      updateData.hours_logged = updates.hours_logged;
    }

    if (updates.entry_date) {
      updateData.entry_date = updates.entry_date;
      updateData.week_start_date = this.getWeekStartDate(new Date(updates.entry_date));
    }

    if (updates.description !== undefined) {
      updateData.description = updates.description;
    }

    const { data, error } = await (supabase as any)
      .from('time_entries')
      .update(updateData)
      .eq('id', entryId)
      .select()
      .single();

    if (error) {
      logger.error('Error updating time entry', {}, error as Error);
      return null;
    }

    return data;
  }

  /**
   * Delete a time entry
   */
  async deleteTimeEntry(entryId: string, db?: any): Promise<boolean> {
    const supabase = db;
    if (!supabase) return false;

    const { error } = await supabase
      .from('time_entries')
      .delete()
      .eq('id', entryId);

    if (error) {
      logger.error('Error deleting time entry', {}, error as Error);
      return false;
    }

    return true;
  }

}

// Export singleton instance
export const timeEntryService = new TimeEntryService();

