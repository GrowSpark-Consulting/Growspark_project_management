// Project update feed type. The feed is read through /api/project-updates.


export type AllProjectUpdate = {
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
  projects?: {
    id: string;
    name: string;
    status: string;
    priority: string;
    accounts?: {
      id: string;
      name: string;
    };
  };
};
