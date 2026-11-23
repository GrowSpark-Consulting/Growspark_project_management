// Project update types. Updates are read and written through /api/projects/[projectId]/updates.

export type ProjectUpdate = {
  id: string;
  project_id: string;
  content: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  user_profiles?: {
    id: string;
    name: string;
    email: string;
    image?: string | null;
  };
};

export type ProjectUpdateInput = {
  project_id: string;
  content: string;
};
