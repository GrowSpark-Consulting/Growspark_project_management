import { Metadata } from 'next';
import { loadPage, seg } from '@/lib/page-data';
import { pageTitle } from '@/lib/page-loaders';

export async function generateMetadata({ params }: { params: Promise<{ projectId: string }> }): Promise<Metadata> {
  const { projectId } = await params;
  const outcome = await loadPage(`title/project/${seg(projectId)}`, () => pageTitle('project', projectId)).catch(() => null);
  return {
    title: (outcome?.kind === 'ok' && outcome.data.title) || 'Project',
  };
}

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  return children;
}
