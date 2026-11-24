import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * GET /api/health: for the hosting platform's health check (Render). 200 when the app runs and, if a
 * database is configured, answers `select 1` within 5 s; 503 otherwise. No data, no sign-in needed.
 */
export async function GET() {
  const started = Date.now();
  let database: 'ok' | 'error' | 'not configured' = 'not configured';
  if (process.env.DATABASE_URL) {
    try {
      await Promise.race([
        db().$queryRawUnsafe('select 1'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
      ]);
      database = 'ok';
    } catch {
      database = 'error';
    }
  }
  const ok = database !== 'error';
  return NextResponse.json(
    { status: ok ? 'ok' : 'error', database, ms: Date.now() - started },
    { status: ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  );
}
