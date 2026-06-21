// Frontend Supabase client. Uses the public anon key (safe to ship to the
// browser) — Row-Level Security in the database is what actually protects data.
// If the env vars aren't set, `supabase` is null and the app runs in local mode
// (no auth gate, in-memory recordings) so development isn't blocked.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const supabaseConfigured = !!(url && anonKey)

export const supabase: SupabaseClient | null = supabaseConfigured
  ? createClient(url!, anonKey!, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null
