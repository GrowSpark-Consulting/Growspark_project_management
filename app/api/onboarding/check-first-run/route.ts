import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getRegistrationState } from '@/lib/registration-state';

// GET - is this a brand-new installation that should go straight to company registration?
// Same rule as /api/register, so "/" and "/login" never send someone to /signup when /signup
// would then say "already set up". If the database can't be read we answer "not first run"
// with 503 (fail closed): the login page stays put instead of bouncing to /signup.
export async function GET() {
  const admin = createAdminSupabaseClient();
  if (!admin) return NextResponse.json({ firstRun: false, error: 'Server configuration error' }, { status: 500 });
  try {
    const state = await getRegistrationState(admin);
    return NextResponse.json({ firstRun: state.open }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ firstRun: false, error: 'Could not check the installation' }, { status: 503 });
  }
}
