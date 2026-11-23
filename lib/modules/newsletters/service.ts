/**
 * Newsletters: server-side business logic. Every query runs as the signed-in user (withUser), so the
 * table's row-level security still decides: any staff member may read newsletters, only a superadmin
 * may write them. Edits and deletes are also limited to the newsletter's author, as before.
 */
import { withUser } from '@/lib/db';
import { newId } from '@/lib/platform/ids';
import type { Newsletter, NewsletterInput } from './types';

const author = { select: { id: true, name: true, email: true, image: true } } as const;

/** The 20 most recently published newsletters, newest first. */
export async function listPublishedNewsletters(userId: string): Promise<Newsletter[]> {
  const rows = await withUser(userId, (tx) =>
    tx.newsletters.findMany({
      where: { is_published: true },
      orderBy: { published_at: 'desc' },
      take: 20,
      include: { user_profiles: author },
    }));
  return rows.map(toNewsletter);
}

/** Create a newsletter, published straight away. */
export async function createNewsletter(userId: string, input: NewsletterInput): Promise<Newsletter> {
  const row = await withUser(userId, (tx) =>
    tx.newsletters.create({
      data: {
        id: newId(),
        title: input.title,
        content: input.content,
        created_by: userId,
        is_published: true,
        published_at: new Date(),
      },
      include: { user_profiles: author },
    }));
  return toNewsletter(row);
}

/** Update the user's own newsletter. Returns null when there is no such newsletter of theirs. */
export async function updateNewsletter(userId: string, id: string, input: Partial<NewsletterInput>): Promise<Newsletter | null> {
  return withUser(userId, async (tx) => {
    const { count } = await tx.newsletters.updateMany({ where: { id, created_by: userId }, data: input });
    if (count === 0) return null;
    const row = await tx.newsletters.findUnique({ where: { id }, include: { user_profiles: author } });
    return row ? toNewsletter(row) : null;
  });
}

/** Delete the user's own newsletter. Returns false when there is no such newsletter of theirs. */
export async function deleteNewsletter(userId: string, id: string): Promise<boolean> {
  const { count } = await withUser(userId, (tx) => tx.newsletters.deleteMany({ where: { id, created_by: userId } }));
  return count > 0;
}

type Row = {
  id: string; title: string; content: string; created_by: string | null; created_at: Date; updated_at: Date;
  is_published: boolean | null; published_at: Date | null;
  user_profiles: { id: string; name: string; email: string; image: string | null } | null;
};

function toNewsletter(row: Row): Newsletter {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    created_by: row.created_by,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    is_published: row.is_published,
    published_at: row.published_at ? row.published_at.toISOString() : null,
    user_profiles: row.user_profiles,
  };
}
