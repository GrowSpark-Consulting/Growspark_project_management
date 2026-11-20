import { NextResponse } from 'next/server';

// Replaced by company registration (POST /api/register), which creates the workspace and its
// manager in one step. Kept as an explicit 410 so old links fail clearly instead of silently.
export async function POST() {
  return NextResponse.json(
    { error: 'First-run setup moved to company registration at /signup', code: 'MOVED' },
    { status: 410 }
  );
}
