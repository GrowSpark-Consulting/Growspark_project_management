'use client'

import { useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "@/lib/hooks/useAuth"
import { landingPathFor } from "@/lib/portal"
import { RegistrationForm } from "@/components/registration-form"

// Company registration. On a new installation the first visitor creates the company workspace and
// becomes its manager; afterwards employees and clients join by invitation only.
export default function Page() {
  const { user, userProfile, loading } = useAuth()
  const router = useRouter()
  // Set the moment the form starts signing the new manager in: from then on the form alone
  // navigates (to /manager), so this page's redirect can't race it.
  const registering = useRef(false)

  // Someone who arrives already signed in goes to their portal instead of the registration form
  useEffect(() => {
    if (registering.current || loading || !user) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    router.replace(userProfile ? landingPathFor(userProfile as any) : '/')
  }, [user, userProfile, loading, router])

  return (
    <div className="flex min-h-svh w-full items-center justify-center bg-bg p-6 md:p-10">
      <div className="w-full max-w-lg">
        <RegistrationForm onRegistering={() => { registering.current = true }} />
      </div>
    </div>
  )
}
