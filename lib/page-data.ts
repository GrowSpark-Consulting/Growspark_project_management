/**
 * Server-rendered pages load their data through this module. Where the server has the database
 * (Render, local) the page's loader runs here; on the frontend-only server (Vercel, BACKEND_URL set)
 * the same loader runs on the backend behind GET /api/pages/<path> and the page receives its result,
 * with the visitor's sign-in cookies forwarded so access rules apply exactly as before.
 * The loaders themselves are in lib/page-loaders.ts.
 */
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { backendUrl } from './frontend-mode';

export type PageOutcome<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'redirect'; to: string }
  | { kind: 'notFound' }
  | { kind: 'denied'; reason: string };

const BACKEND_TIMEOUT_MS = 30_000;

export async function loadPage<T>(path: string, local: () => Promise<PageOutcome<T>>): Promise<PageOutcome<T>> {
  const backend = backendUrl();
  if (!backend) return local();
  const incoming = await headers();
  const forward: Record<string, string> = { accept: 'application/json' };
  for (const name of ['cookie', 'x-forwarded-for', 'user-agent']) {
    const value = incoming.get(name);
    if (value) forward[name] = value;
  }
  const res = await fetch(`${backend}/api/pages/${path}`, {
    headers: forward,
    cache: 'no-store',
    signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Backend /api/pages/${path} answered ${res.status}`);
  return (await res.json()) as PageOutcome<T>;
}

/** Follows a redirect or not-found outcome; otherwise returns the data, or why access was denied. */
export function settle<T>(outcome: PageOutcome<T>): { data: T; denied?: undefined } | { data?: undefined; denied: string } {
  if (outcome.kind === 'redirect') redirect(outcome.to);
  if (outcome.kind === 'notFound') notFound();
  return outcome.kind === 'denied' ? { denied: outcome.reason } : { data: outcome.data };
}

/** Path segment for an id taken from the URL. */
export const seg = (value: string) => encodeURIComponent(value);
