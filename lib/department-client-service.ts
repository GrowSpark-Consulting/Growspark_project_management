// Department page types. The department pages load their data on the server; the browser's
// department changes go through /api/departments (create) and /api/departments/[departmentId].

import type { Project } from './supabase';

export interface DepartmentMetrics {
  id: string;
  name: string;
  description: string | null;
  activeProjects: number;
  teamSize: number;
  capacityUtilization: number;
  projectHealth: {
    healthy: number;
    atRisk: number;
    critical: number;
  };
  workloadDistribution: {
    userId: string;
    userName: string;
    userImage: string | null;
    workloadPercentage: number;
    workloadSentiment: 'comfortable' | 'stretched' | 'overwhelmed' | null;
  }[];
  recentProjects: Project[];
}

export interface DepartmentProject {
  id: string;
  name: string;
  description: string | null;
  status: 'planning' | 'in_progress' | 'review' | 'complete' | 'on_hold';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  startDate: string | null;
  endDate: string | null;
  estimatedHours: number | null;
  actualHours: number;
  accountName: string;
  assignedUsers: {
    id: string;
    name: string;
    image: string | null;
  }[];
  healthStatus: 'healthy' | 'at_risk' | 'critical';
  daysUntilDeadline: number | null;
}
