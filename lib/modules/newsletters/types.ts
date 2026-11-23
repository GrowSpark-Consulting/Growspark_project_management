/** Newsletters shown on the welcome page. Shared by the API and the browser (no server imports). */

export type Newsletter = {
  id: string;
  title: string;
  content: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  is_published: boolean | null;
  published_at: string | null;
  user_profiles?: {
    id: string;
    name: string;
    email: string;
    image?: string | null;
  } | null;
};

export type NewsletterInput = {
  title: string;
  content: string;
};
