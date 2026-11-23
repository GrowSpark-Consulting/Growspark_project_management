import { NextRequest, NextResponse } from 'next/server';
import { createApiSupabaseClient } from '@/lib/supabase-server';
import { fetchUserProfileOptimized } from '@/lib/profile-loader';
import { loadDirectMemberships } from '@/lib/department-membership';

export const dynamic = 'force-dynamic';

/**
 * GET /api/me/profile: the signed-in user's profile with roles and direct department memberships, for
 * the app's auth context (moved off browser queries). Runs as the user, so row-level security applies.
 * Works for every signed-in account, including client and deactivated ones: the app decides what they
 * see from the profile, as before. Signed out: 401 with no profile.
 */
export async function GET(request: NextRequest) {
  const supabase = createApiSupabaseClient(request);
  if (!supabase) return NextResponse.json({ error: 'Server is not configured' }, { status: 500 });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ data: null, error: 'Not signed in' }, { status: 401 });

  const profile = await fetchUserProfileOptimized(supabase, user.id);
  if (!profile) return NextResponse.json({ data: null });
  profile.department_members = await loadDirectMemberships(supabase, user.id);
  return NextResponse.json({ data: profile }, { headers: { 'Cache-Control': 'no-store' } });
}
