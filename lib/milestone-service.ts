// Milestone types. Timeline milestones are read and added through /api/milestones (lib/client-queries.ts);
// project milestones through /api/projects/[projectId]/milestones and /api/milestones/[id].

export type Milestone = {
  id: string;
  name: string;
  description?: string | null;
  date: string; // ISO timestamp
  color?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type MilestoneInput = {
  name: string;
  description?: string;
  date: Date;
  color?: string;
};
