import { redirect } from 'next/navigation';
import Link from 'next/link';

export const metadata = { title: 'Privacy Policy' };

// The legal text is your organisation's to provide: set NEXT_PUBLIC_PRIVACY_URL to publish it.
export default function Page() {
  const url = process.env.NEXT_PUBLIC_PRIVACY_URL;
  if (url) redirect(url);
  return (
    <main className="mx-auto max-w-2xl px-4 py-12 space-y-4">
      <h1 className="text-2xl font-semibold text-ink">Privacy Policy</h1>
      <p className="text-ink-muted">The Privacy Policy for this workspace has not been published yet. The workspace owner can publish it by setting <code>NEXT_PUBLIC_PRIVACY_URL</code> on the server.</p>
      <p><Link href="/signup" className="underline">Back</Link></p>
    </main>
  );
}
