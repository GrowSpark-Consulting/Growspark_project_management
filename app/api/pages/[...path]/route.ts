import { NextRequest, NextResponse } from 'next/server';
import { loaderFor } from '@/lib/page-loaders';
import { logger } from '@/lib/debug-logger';

export const dynamic = 'force-dynamic';

/**
 * GET /api/pages/<path>: the server-side data of one server-rendered page, for the frontend-only
 * server (Vercel), which has no database (lib/page-data.ts). Same sign-in cookies, same access rules
 * as when the page loads it itself: the answer is what that page would have rendered for this visitor.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  // The page's own query (e.g. ?page=2&q=acme) is passed on to its loader
  const load = loaderFor(path, request.nextUrl.searchParams);
  if (!load) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  try {
    return NextResponse.json(await load(), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    logger.error('Page data failed', { path: path.join('/') }, error as Error);
    return NextResponse.json({ error: 'Could not load the page data' }, { status: 500 });
  }
}
