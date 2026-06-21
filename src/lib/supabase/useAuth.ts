import { useEffect, useState } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase, supabaseConfigured } from './client'

export interface AuthApi {
  /** auth library has finished its initial session check */
  ready: boolean
  /** Supabase isn't configured — app runs without auth (local mode) */
  localMode: boolean
  session: Session | null
  user: User | null
  signUp: (email: string, password: string) => Promise<{ error?: string; needsConfirm?: boolean }>
  signIn: (email: string, password: string) => Promise<{ error?: string }>
  signOut: () => Promise<void>
}

export function useAuth(): AuthApi {
  const [ready, setReady] = useState(!supabaseConfigured)
  const [session, setSession] = useState<Session | null>(null)

  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true) })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  const signUp = async (email: string, password: string) => {
    if (!supabase) return { error: 'Auth not configured.' }
    const { data, error } = await supabase.auth.signUp({ email: email.trim(), password })
    if (error) return { error: error.message }
    // when email confirmation is ON, there's a user but no session yet
    const needsConfirm = !!data.user && !data.session
    return { needsConfirm }
  }

  const signIn = async (email: string, password: string) => {
    if (!supabase) return { error: 'Auth not configured.' }
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    return error ? { error: error.message } : {}
  }

  const signOut = async () => { await supabase?.auth.signOut() }

  return {
    ready,
    localMode: !supabaseConfigured,
    session,
    user: session?.user ?? null,
    signUp,
    signIn,
    signOut,
  }
}
