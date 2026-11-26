'use client'

import React, { createContext, useContext, useState, useEffect, useRef } from 'react'
import { User } from '@supabase/supabase-js'
import { createClientSupabase } from '../supabase'
import { getCurrentUserProfile, signOut, ServerUnavailableError } from '../auth'
import { UserWithRoles } from '../rbac'
import { clearPermissionCache } from '../permission-checker'
import { logger } from '../debug-logger'
import { clearPersistentState } from '../hooks/use-persistent-state'

interface AuthContextType {
  user: User | null
  userProfile: UserWithRoles | null
  loading: boolean
  error: string | null
  signOut: () => Promise<void>
  refreshProfile: () => Promise<void>
  isAuthenticated: boolean
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [userProfile, setUserProfile] = useState<UserWithRoles | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // The listener below is created once, so it reads the current profile through this ref
  // (reading the state directly would always see the first render's null)
  const profileRef = useRef<UserWithRoles | null>(null)
  useEffect(() => { profileRef.current = userProfile }, [userProfile])

  useEffect(() => {
    const supabase = createClientSupabase()
    if (!supabase) {
      setLoading(false)
      return
    }

    let currentProfileRequest: Promise<UserWithRoles | null> | null = null
    let isMounted = true

    const getInitialSession = async () => {
      try {
        const { data: { session }, error } = await supabase.auth.getSession()

        if (!isMounted) return

        if (error) {
          logger.error('Error getting session', {}, error as Error)
          setError(error.message)
          setLoading(false)
          return
        }

        if (session?.user) {
          setUser(session.user)

          const initialProfileRequest = getCurrentUserProfile()
          currentProfileRequest = initialProfileRequest
          initialProfileRequest
            .then(async (profile) => {
              if (isMounted && currentProfileRequest === initialProfileRequest) {
                if (!profile) {
                  // User exists in auth but not in user_profiles (stale session after DB reset)
                  logger.error('User session exists but profile not found — clearing stale session')
                  try { await supabase.auth.signOut() } catch { /* ignore */ }
                  setUser(null)
                  setUserProfile(null)
                } else {
                  setUserProfile(profile)
                }
                setLoading(false)
              }
            })
            .catch(async (error) => {
              if (isMounted && error instanceof ServerUnavailableError) {
                // The server is down or still waking: keep the person signed in, they can reload in a moment
                logger.error('Server unavailable while loading the user profile', {}, error as Error)
                setError('The server is not responding. Please reload the page in a moment.')
                setLoading(false)
                return
              }
              if (isMounted) {
                logger.error('Error loading initial user profile', {}, error as Error)
                // Profile fetch failed — session is likely stale (user doesn't exist in DB)
                // Sign out to clear invalid cookies and prevent login/welcome loop
                try {
                  await supabase.auth.signOut()
                } catch { /* ignore signout errors */ }
                setUser(null)
                setUserProfile(null)
                setLoading(false)
              }
            })
        } else {
          setUser(null)
          setUserProfile(null)
          setLoading(false)
        }
      } catch (error: unknown) {
        if (isMounted) {
          logger.error('Error in getInitialSession', {}, error as Error)
          setError('Failed to load user session')
          setUser(null)
          setUserProfile(null)
          setLoading(false)
        }
      }
    }

    getInitialSession()

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event: string, session: any) => {
        if (!isMounted) return

        if (event === 'INITIAL_SESSION') {
          return
        }

        if (event === 'TOKEN_REFRESHED' && session?.user) {
          setUser(session.user)
          return
        }

        // Supabase repeats SIGNED_IN for the same person (e.g. when the tab becomes visible again).
        // The profile is already loaded: keep the app as it is instead of showing loading states again.
        if (event === 'SIGNED_IN' && session?.user && profileRef.current?.id === session.user.id) {
          setUser(session.user)
          return
        }

        currentProfileRequest = null

        if (event === 'SIGNED_OUT') {
          setUser(null)
          setUserProfile(null)
          setLoading(false)
          return
        }

        if (session?.user) {
          setUser(session.user)
          // Another person (or nobody yet): show loading until their profile is there.
          // Same person (e.g. USER_UPDATED): refresh the profile in the background.
          if (profileRef.current?.id !== session.user.id) setLoading(true)

          const profileRequest = getCurrentUserProfile()
          currentProfileRequest = profileRequest

          profileRequest
            .then(profile => {
              if (isMounted && currentProfileRequest === profileRequest) {
                setUserProfile(profile)
                setLoading(false)
              }
            })
            .catch(error => {
              if (isMounted && currentProfileRequest === profileRequest) {
                logger.error('Error loading user profile', {}, error as Error)
                setUserProfile(null)
                setLoading(false)
              }
            })
        } else {
          setUser(currentUser => {
            if (currentUser) {
              supabase.auth.refreshSession()
                .then(({ data: { session: refreshedSession }, error: refreshError }: { data: { session: any }, error: unknown }) => {
                  if (refreshError || !refreshedSession) {
                    setUser(null)
                    setUserProfile(null)
                    setLoading(false)
                  } else {
                    setUser(refreshedSession.user)
                    setLoading(false)
                  }
                })
                .catch((refreshErr: any) => {
                  logger.error('Error refreshing session', {}, refreshErr as Error)
                  setUser(null)
                  setUserProfile(null)
                  setLoading(false)
                })
              return currentUser
            } else {
              setUserProfile(null)
              setLoading(false)
              return null
            }
          })
        }
      }
    )

    return () => {
      isMounted = false
      currentProfileRequest = null
      subscription.unsubscribe()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // userProfile intentionally excluded - adding it would cause subscription to re-create on every profile change

  const handleSignOut = async () => {
    try {
      setLoading(true)
      await signOut()
      // Remembered filters and tabs belong to the person who signed out
      clearPersistentState()
      setUser(null)
      setUserProfile(null)
    } catch (error: unknown) {
      logger.error('Error signing out', {}, error as Error)
      setError('Failed to sign out')
    } finally {
      setLoading(false)
    }
  }

  const refreshProfile = async () => {
    // With a profile already loaded, refresh it in the background: the app stays as it is meanwhile
    const silent = !!profileRef.current
    try {
      if (!silent) setLoading(true)
      // Clear permission cache when refreshing profile to get fresh permissions
      clearPermissionCache()
      const profile = await getCurrentUserProfile()
      setUserProfile(profile)
    } catch (error: unknown) {
      logger.error('Error refreshing profile', {}, error as Error)
      setError('Failed to refresh profile')
    } finally {
      if (!silent) setLoading(false)
    }
  }

  // DISABLED: Periodic background refresh was causing jarring UI updates
  // Permission changes will be picked up on next page navigation or explicit refresh
  // Users can manually refresh the page if they need to see permission changes immediately

  const value = {
    user,
    userProfile,
    loading,
    error,
    signOut: handleSignOut,
    refreshProfile,
    isAuthenticated: !!user,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
