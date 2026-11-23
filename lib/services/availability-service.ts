
/**
 * User Availability Service
 * Manages weekly user work capacity and availability schedules
 */


import type { AppSupabaseClient } from '../supabase';
import { logger } from '../debug-logger';

type UserAvailability = any;
type UserAvailabilityInsert = any;
type _UserAvailabilityUpdate = any;

export interface WeeklySchedule {
  monday?: number;
  tuesday?: number;
  wednesday?: number;
  thursday?: number;
  friday?: number;
  saturday?: number;
  sunday?: number;
}

export interface AvailabilityWithSchedule extends Omit<UserAvailability, 'schedule_data'> {
  schedule_data: WeeklySchedule | null;
}

class AvailabilityService {
  /**
   * Get Monday of the week for a given date
   */
  getWeekStartDate(date: Date = new Date()): string {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Adjust when day is Sunday
    const monday = new Date(d.setDate(diff));
    return monday.toISOString().split('T')[0];
  }

  /**
   * Get user availability for a specific week
   */
  async getUserAvailability(
    userId: string,
    weekStartDate?: string,
    supabaseClient?: AppSupabaseClient | null
  ): Promise<AvailabilityWithSchedule | null> {
    const supabase = supabaseClient;
    if (!supabase) return null;

    const targetWeek = weekStartDate || this.getWeekStartDate();

    const { data, error } = await supabase
      .from('user_availability')
      .select('*')
      .eq('user_id', userId)
      .eq('week_start_date', targetWeek)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        // No record found - return default
        return null;
      }
      logger.error('Error fetching user availability', {}, error as Error);
      return null;
    }

    return data as AvailabilityWithSchedule;
  }

  /**
   * Set or update user availability for a week
   */
  async setUserAvailability(
    userId: string,
    weekStartDate: string,
    availableHours: number,
    scheduleData?: WeeklySchedule,
    notes?: string,
    supabaseClient?: AppSupabaseClient | null
  ): Promise<AvailabilityWithSchedule | null> {
    const supabase = supabaseClient;
    if (!supabase) return null;

    // Check if record exists
    const existing = await this.getUserAvailability(userId, weekStartDate, supabase);

    if (existing) {
      // Update existing record
       
      const { data, error } = await (supabase as any)
        .from('user_availability')
        .update({
          available_hours: availableHours,
          schedule_data: (scheduleData || existing.schedule_data) as Record<string, unknown> | null,
          notes: notes !== undefined ? notes : existing.notes,
        })
        .eq('id', existing.id)
        .select()
        .single();

      if (error) {
        logger.error('Error updating user availability', {}, error as Error);
        return null;
      }

      return data as AvailabilityWithSchedule;
    } else {
      // Insert new record
      const insertData: UserAvailabilityInsert = {
        user_id: userId,
        week_start_date: weekStartDate,
        available_hours: availableHours,
        schedule_data: (scheduleData as Record<string, unknown>) || null,
        notes: notes || null,
      };

       
      const { data, error } = await (supabase as any)
        .from('user_availability')
        .insert([insertData])
        .select()
        .single();

      if (error) {
        logger.error('Error inserting user availability', {}, error as Error);
        return null;
      }

      return data as AvailabilityWithSchedule;
    }
  }

  /**
   * Delete user availability for a week
   */
  async deleteUserAvailability(
    userId: string,
    weekStartDate: string,
    supabaseClient?: AppSupabaseClient | null
  ): Promise<boolean> {
    const supabase = supabaseClient;
    if (!supabase) return false;

    const { error } = await supabase
      .from('user_availability')
      .delete()
      .eq('user_id', userId)
      .eq('week_start_date', weekStartDate);

    if (error) {
      logger.error('Error deleting user availability', {}, error as Error);
      return false;
    }

    return true;
  }

  /**
   * Calculate total hours from schedule data
   */
  calculateTotalHours(schedule: WeeklySchedule): number {
    return Object.values(schedule).reduce((sum, hours) => sum + (hours || 0), 0);
  }

}

// Export singleton instance
export const availabilityService = new AvailabilityService();

