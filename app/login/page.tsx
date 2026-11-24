'use client'

import { Suspense, useEffect, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/lib/hooks/useAuth"
import { LoginForm } from "@/components/login-form"
import { DemoLoginForm } from "@/components/demo-login-form"
import { isDemoMode } from "@/lib/demo-mode"
import { isSupabaseConfigured } from "@/lib/supabase"
import { landingPathFor, isActiveProfile } from "@/lib/portal"
import { signOutThisBrowser, signedInAsSomeoneElse } from "@/lib/invite-sign-in"

export default function Page() {
  const { user, userProfile, loading } = useAuth()
  const router = useRouter()
  const supabaseReady = isSupabaseConfigured()
  // No company workspace registered yet: the login form stays, with a way to create the workspace
  // (the home page sends a new installation to /signup by itself)
  const [noWorkspace, setNoWorkspace] = useState(false)

  useEffect(() => {
    if (!supabaseReady) return
    fetch('/api/onboarding/check-first-run')
      .then(res => res.json())
      .then(data => setNoWorkspace(data.firstRun === true))
      .catch(() => {})
  }, [supabaseReady])

  useEffect(() => {
    // Wait until the session and the profile are loaded
    if (loading || !user || !userProfile) return
    // A link meant for someone else (e.g. a just-invited employee opening it where the manager is
    // signed in): sign the other account out on this browser and show the login form, rather than
    // opening the other person's portal
    const wanted = new URLSearchParams(window.location.search).get('email')
    if (signedInAsSomeoneElse(user.email, wanted)) {
      signOutThisBrowser()
      return
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const profile = userProfile as any
    if (!isActiveProfile(profile)) return

    // Signed in: honour a safe ?redirectTo, otherwise the role's portal
    // (client -> /client-portal, manager -> /manager, others -> /dashboard), same rule as "/"
    const requested = new URLSearchParams(window.location.search).get('redirectTo')
    const safe = requested && requested.startsWith('/') && !requested.startsWith('//') && requested !== '/' ? requested : null
    router.replace(safe || landingPathFor(profile))
  }, [user, userProfile, loading, router])

  // Show loading state while checking auth
  if (loading) {
    return (
      <div className="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
        <div className="w-full max-w-sm text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 mx-auto"></div>
          <p className="mt-2 text-sm text-gray-600">Checking authentication...</p>
        </div>
      </div>
    )
  }

  // If user is authenticated, show loading while redirecting
  if (user) {
    return (
      <div className="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
        <div className="w-full max-w-sm text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 mx-auto"></div>
          <p className="mt-2 text-sm text-gray-600">Redirecting...</p>
        </div>
      </div>
    )
  }

  // User is not authenticated, show login form
  const demoMode = isDemoMode()

  return (
    <div className="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
      <div className={demoMode ? "w-full max-w-2xl" : "w-full max-w-sm"}>
        {/* Show setup instructions when database is not configured */}
        {!supabaseReady && (
          <div className="mb-6 p-4 border border-amber-300 bg-amber-50 rounded-lg">
            <h2 className="text-sm font-semibold text-amber-800 mb-2">Database Not Connected</h2>
            <p className="text-sm text-amber-700 mb-3">
              Supabase is not configured. To get started:
            </p>
            <ol className="text-sm text-amber-700 space-y-1 list-decimal list-inside">
              <li>Copy <code className="bg-amber-100 px-1 rounded text-xs">.env.local.template</code> to <code className="bg-amber-100 px-1 rounded text-xs">.env.local</code></li>
              <li>Install and start Docker Desktop</li>
              <li>Run <code className="bg-amber-100 px-1 rounded text-xs">npm run dev:demo</code> to start with demo data</li>
            </ol>
            <p className="text-xs text-amber-600 mt-3">
              See the README for detailed setup instructions.
            </p>
          </div>
        )}

        {noWorkspace && (
          <div role="status" className="mb-6 rounded-lg border border-line bg-surface p-4 text-sm">
            <p className="font-medium">No company workspace has been created here yet.</p>
            <p className="mt-1 text-ink-muted">Create it first; you become its manager and invite everyone else.</p>
            <Button asChild className="mt-3 w-full"><Link href="/signup">Create your company workspace</Link></Button>
          </div>
        )}

        <Suspense fallback={<div>Loading...</div>}>
          {demoMode ? <DemoLoginForm /> : <LoginForm />}
        </Suspense>
      </div>
    </div>
  )
}
