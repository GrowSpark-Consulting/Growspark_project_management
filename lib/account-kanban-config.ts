
import { logger } from './debug-logger';

export interface KanbanColumn {
  id: string;
  name: string;
  color: string;
  order: number;
  [key: string]: unknown;
}

export interface AccountKanbanConfig {
  id: string;
  account_id: string;
  columns: KanbanColumn[];
  created_at: string;
  updated_at: string;
}

// Default Kanban columns
export const DEFAULT_KANBAN_COLUMNS: KanbanColumn[] = [
  { id: 'planned', name: 'Planned', color: '#6B7280', order: 1 },
  { id: 'in-progress', name: 'In Progress', color: '#3B82F6', order: 2 },
  { id: 'review', name: 'Review', color: '#F59E0B', order: 3 },
  { id: 'complete', name: 'Complete', color: '#10B981', order: 4 },
];

class AccountKanbanConfigService {
  // Pure helpers only. Saved columns are read and written through /api/accounts/[accountId]/kanban-config

  // Helper function to map project status to kanban column
  getKanbanColumnForStatus(status: string, columns: KanbanColumn[], _customAssignments?: Record<string, string>): string {
    const statusToColumnMap: { [key: string]: string } = {
      'planning': 'planned',
      'in_progress': 'in-progress',
      'review': 'review',
      'complete': 'complete',
      'on_hold': 'planned', // Default on_hold to planned
    };
    
    const defaultColumn = statusToColumnMap[status] || 'planned';
    
    // Check if the mapped column exists in the account's columns
    const columnExists = columns.some((col: any) => col.id === defaultColumn);
    if (columnExists) {
      return defaultColumn;
    }
    
    // If not, return the first column
    return columns[0]?.id || 'planned';
  }

  // Helper function to map kanban column to project status
  getStatusForKanbanColumn(columnId: string, columns: KanbanColumn[]): string {
    logger.debug('[KANBAN CONFIG] Mapping column to status', {
      columnId,
      columns: columns.map((col: any) => ({ id: col.id, name: col.name }))
    });
    
    const columnToStatusMap: { [key: string]: string } = {
      'planned': 'planning',
      'in-progress': 'in_progress',
      'review': 'review',
      'complete': 'complete',
    };
    
    // Check if this is a custom column
    const customColumn = columns.find((col: any) => col.id === columnId);
    logger.debug('[KANBAN CONFIG] Custom column found', { customColumn });
    
    if (customColumn && !columnToStatusMap[columnId]) {
      // For custom columns, map to the closest valid database status
      // This ensures we only use valid database status values
      const customColumnName = customColumn.name.toLowerCase();
      logger.debug('[KANBAN CONFIG] Custom column name', { customColumnName });
      
      if (customColumnName.includes('review') && !customColumnName.includes('approved')) {
        logger.debug('[KANBAN CONFIG] Mapping to review status', {});
        return 'review'; // Map review columns to review status
      } else if (customColumnName.includes('approved') || customColumnName.includes('approval')) {
        logger.debug('[KANBAN CONFIG] Mapping to review status for approved (visual only)', {});
        return 'review'; // Map approved columns to review status (approved is visual only)
      } else if (customColumnName.includes('pending')) {
        logger.debug('[KANBAN CONFIG] Mapping to review status for pending', {});
        return 'review'; // Map pending columns to review status
      } else if (customColumnName.includes('blocked') || customColumnName.includes('hold')) {
        logger.debug('[KANBAN CONFIG] Mapping to on_hold status', {});
        return 'on_hold'; // Map blocked/hold columns to on_hold status
      } else if (customColumnName.includes('done') || customColumnName.includes('finished')) {
        logger.debug('[KANBAN CONFIG] Mapping to complete status', {});
        return 'complete'; // Map done/finished columns to complete status
      } else {
        logger.debug('[KANBAN CONFIG] Mapping to planning status (default)', {});
        return 'planning'; // Default custom columns to planning status
      }
    }
    
    const mappedStatus = columnToStatusMap[columnId] || 'planning';
    logger.debug('[KANBAN CONFIG] Final mapped status', { mappedStatus });
    return mappedStatus;
  }
}

export const accountKanbanConfigService = new AccountKanbanConfigService();
