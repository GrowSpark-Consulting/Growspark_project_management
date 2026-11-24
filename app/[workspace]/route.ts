import { NextRequest, NextResponse } from 'next/server';
import { loadPage, seg } from '@/lib/page-data';
import { workspaceMatches } from '@/lib/page-loaders';

// The workspace URL (e.g. /growspark). One company per installation: the URL opens this workspace;
// signed-out visitors are sent to the login page by the middleware first. Any other single-segment
// path that isn't a page answers 404. A route handler (not a page) so the redirect is a real 307
// instead of being streamed inside the root layout. Static routes always take precedence.
export async function GET(request: NextRequest, { params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params;
  const outcome = await loadPage(`workspace/${seg(workspace)}`, () => workspaceMatches(workspace)).catch(() => null);
  if (outcome?.kind === 'ok' && outcome.data.matches) {
    return NextResponse.redirect(new URL('/', request.url), 307);
  }
  return new NextResponse(
    '<!doctype html><meta charset="utf-8"><title>Page not found</title><body style="font-family:system-ui;padding:3rem"><h1>Page not found</h1><p><a href="/">Go to the home page</a></p></body>',
    { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}
