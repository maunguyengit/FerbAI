// Server-side Supabase admin client (service_role). NEVER exposed to the
// browser. Used only to issue short-lived signed URLs for recording audio after
// verifying the requester is allowed to hear it (owner, or recording is shared).

import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const serviceRole = process.env.SUPABASE_SERVICE_ROLE

export const supabaseEnabled = !!(url && serviceRole)

export const supabaseAdmin = supabaseEnabled
  ? createClient(url, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } })
  : null

export const AUDIO_BUCKET = 'recordings'
