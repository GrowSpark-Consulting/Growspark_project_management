import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'

/**
 * Auth Callback Route
 *
 * This route handles Supabase auth callbacks for:
 * 1. Email confirmation (after signup)
 * 2. Password reset links
 * 3. Magic link logins (if enabled)
 *
 * Supabase redirects users here with a `code` parameter that needs to be
 * exchanged for a session.
 *
 * Runs on the backend: the frontend-only server (Vercel) forwards this path to it (next.config.ts).
 * Redirects are therefore relative, so the browser stays on the address it came from.
 */
const goTo = (path: string) => new NextResponse(null, { status: 307, headers: { Location: path } })

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const rawNext = searchParams.get('next') ?? '/welcome'
  // Prevent open redirect: only allow internal paths (must start with / and not //)
  const next = (rawNext.startsWith('/') && !rawNext.startsWith('//')) ? rawNext : '/welcome'
  const type = searchParams.get('type') // 'recovery', 'signup', 'invite', etc.

  if (code) {
    const cookieStore = await cookies()

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY!,
      {
        // The browser client's cookie name (lib/supabase.ts): the one-time code verifier is stored under
        // it, and the session set here must be the one the app reads
        cookieOptions: { name: 'sb-project-management-auth' },
        cookies: {
          getAll() {
            return cookieStore.getAll()
          },
          setAll(cookiesToSet) {
            try {
              cookiesToSet.forEach(({ name, value, options }) =>
                cookieStore.set(name, value, options)
              )
            } catch {
              // The `setAll` method was called from a Server Component.
              // This can be ignored if you have middleware refreshing
              // user sessions.
            }
          },
        },
      }
    )

    // Exchange the code for a session
    const { error } = await supabase.auth.exchangeCodeForSession(code)

    if (!error) {
      // Determine where to redirect based on the type of auth action
      let redirectTo = next

      if (type === 'recovery') {
        // Password reset - redirect to reset password page
        redirectTo = '/reset-password'
      } else if (type === 'signup' || type === 'email') {
        // Email confirmation - redirect to welcome page
        redirectTo = '/welcome'
      } else if (type === 'invite') {
        // User invitation - redirect to welcome page
        redirectTo = '/welcome'
      }

      return goTo(redirectTo)
    }

    // If there was an error exchanging the code, redirect to login with error
    return goTo('/login?error=auth_callback_failed')
  }

  // No code provided - redirect to login
  return goTo('/login?error=no_code')
}
