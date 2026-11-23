

import { logger } from './debug-logger';

type _TaskRow = any;
type TaskInsert = any;
type TaskUpdate = any;

// Task interface matching the database schema
export interface Task {
  id: string;
  name: string;
  description: string | null;
  project_id: string;
  status: 'backlog' | 'todo' | 'in_progress' | 'review' | 'done' | 'blocked';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  start_date: string | null;
  due_date: string | null;
  estimated_hours: number | null;
  remaining_hours: number | null;
  actual_hours: number;
  created_by: string;
  assigned_to: string | null;
  created_at: string;
  updated_at: string;
  parent_task_id?: string | null;
  progress_percent?: number;
  // Joined data
  created_by_user?: {
    id: string;
    name: string;
    email: string;
  };
  assigned_to_user?: {
    id: string;
    name: string;
    email: string;
  };
  project?: {
    id: string;
    name: string;
  };
}

export interface CreateTaskData {
  name: string;
  description?: string | null;
  project_id: string;
  status?: 'backlog' | 'todo' | 'in_progress' | 'review' | 'done' | 'blocked';
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  start_date?: string | null;
  due_date?: string | null;
  estimated_hours?: number | null;
  created_by: string;
  assigned_to?: string | null;
}

export interface UpdateTaskData {
  id: string;
  name?: string;
  description?: string | null;
  status?: 'backlog' | 'todo' | 'in_progress' | 'review' | 'done' | 'blocked';
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  start_date?: string | null;
  due_date?: string | null;
  estimated_hours?: number | null;
  actual_hours?: number;
  remaining_hours?: number | null;
  assigned_to?: string | null;
}

class TaskServiceDB {
  // Runs on the server with the signed-in user's client (the project page calls /api/projects/[id]/page-data)
  private getSupabase(db: any) {
    if (!db) throw new Error('Database client required');
    return db;
  }

  /**
   * Get all tasks for a specific project
   * Calculates actual_hours from time_entries instead of using stored value
   */
  async getTasksByProject(projectId: string, db: any): Promise<Task[]> {
    // Guard against invalid projectId
    if (!projectId || typeof projectId !== 'string') {
      logger.warn('getTasksByProject called with invalid projectId', { projectId });
      return [];
    }

    try {
      const supabase = this.getSupabase(db);

      const { data, error } = await supabase
        .from('tasks')
        .select(`
          *,
          created_by_user:user_profiles!created_by(id, name, email),
          assigned_to_user:user_profiles!assigned_to(id, name, email),
          project:projects(id, name)
        `)
        .eq('project_id', projectId)
        .order('created_at', { ascending: false });

      if (error) {
        logger.error('Error fetching tasks', {
          message: error.message,
          code: error.code,
          details: error.details,
          hint: error.hint,
          projectId
        });
        throw error;
      }

      if (!data || data.length === 0) {
        return [];
      }

      // Get task IDs to fetch time entries
      const taskIds = data.map((t: { id: string }) => t.id);

      // Fetch time entries for all tasks in this project
      const { data: timeEntries, error: timeError } = await supabase
        .from('time_entries')
        .select('task_id, hours_logged')
        .in('task_id', taskIds);

      if (timeError) {
        logger.error('Error fetching time entries', {
          message: timeError.message,
          code: timeError.code,
          details: timeError.details,
          hint: timeError.hint,
          taskCount: taskIds.length
        });
        // Continue without time entries - use stored actual_hours
        return data.map(this.mapTaskRowToTask);
      }

      // Calculate sum of hours per task
      const hoursPerTask = new Map<string, number>();
      if (timeEntries) {
        for (const entry of timeEntries) {
          const typedEntry = entry as { task_id: string | null; hours_logged: number | null };
          if (typedEntry.task_id) {
            const current = hoursPerTask.get(typedEntry.task_id) || 0;
            hoursPerTask.set(typedEntry.task_id, current + (typedEntry.hours_logged || 0));
          }
        }
      }

      // Map tasks and override actual_hours with calculated value
      return data.map((row: any) => {
        const task = this.mapTaskRowToTask(row);
        // Use calculated hours from time entries
        task.actual_hours = hoursPerTask.get(task.id) || 0;
        return task;
      });
    } catch (error: unknown) {
      const err = error as { message?: string; code?: string; stack?: string };
      logger.error('Error in getTasksByProject', {
        message: err?.message || 'Unknown error',
        code: err?.code,
        projectId
      }, error as Error);
      return [];
    }
  }

  /**
   * Map database row to Task interface
   */
  private mapTaskRowToTask(row: any): Task {
    return {
      id: row.id as string,
      name: row.name as string,
      description: row.description as string | null,
      project_id: row.project_id as string,
      status: row.status as 'backlog' | 'todo' | 'in_progress' | 'review' | 'done' | 'blocked',
      priority: row.priority as 'low' | 'medium' | 'high' | 'urgent',
      start_date: row.start_date as string | null,
      due_date: row.due_date as string | null,
      estimated_hours: row.estimated_hours as number | null,
      remaining_hours: row.remaining_hours as number | null,
      actual_hours: row.actual_hours as number,
      created_by: row.created_by as string,
      assigned_to: (row.assigned_to as string | null) || null,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      parent_task_id: (row.parent_task_id as string | null) ?? null,
      progress_percent: Number(row.progress_percent ?? 0),
      created_by_user: row.created_by_user as { id: string; name: string; email: string } | undefined,
      assigned_to_user: row.assigned_to_user as { id: string; name: string; email: string } | undefined,
      project: row.project as { id: string; name: string } | undefined,
    };
  }
}

// Export singleton instance
export const taskServiceDB = new TaskServiceDB();

