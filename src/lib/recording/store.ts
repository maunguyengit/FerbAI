// Supabase persistence for recordings. User data goes browser → Supabase,
// protected by Row-Level Security. Audio blobs live in a private Storage bucket;
// playback of a recording's audio goes through the server (signed URL) so shared
// recordings can be heard by other signed-in users.

import { supabase } from '../supabase/client'
import type { Recording, SceneEvent, Snapshot } from './types'

const BUCKET = 'recordings'

interface Row {
  id: string
  owner: string
  title: string
  duration_ms: number
  events: SceneEvent[]
  snapshots: Snapshot[]
  transcript: unknown
  chapters: unknown
  audio_path: string | null
  audio_mime: string | null
  shared: boolean
  created_at: string
}

function rowToRecording(row: Row, mine: boolean): Recording {
  return {
    id: row.id,
    title: row.title,
    createdAt: new Date(row.created_at).getTime(),
    durationMs: row.duration_ms,
    events: row.events ?? [],
    snapshots: row.snapshots ?? [],
    transcript: (row.transcript as Recording['transcript']) ?? undefined,
    chapters: (row.chapters as Recording['chapters']) ?? undefined,
    audioMime: row.audio_mime ?? undefined,
    audioPath: row.audio_path ?? undefined,
    shared: row.shared,
    remote: true,
    mine,
  }
}

/** Persist a just-recorded lesson: upload audio, then insert the row. */
export async function saveRecording(rec: Recording, ownerId: string): Promise<Recording | null> {
  if (!supabase) return null
  const id = crypto.randomUUID()

  let audioPath: string | null = null
  if (rec.audioBlob) {
    const path = `${ownerId}/${id}.webm`
    const { error } = await supabase.storage.from(BUCKET).upload(path, rec.audioBlob, {
      contentType: rec.audioMime || 'audio/webm', upsert: true,
    })
    if (!error) audioPath = path
  }

  const { data, error } = await supabase.from('recordings').insert({
    id, owner: ownerId, title: rec.title, duration_ms: rec.durationMs,
    events: rec.events, snapshots: rec.snapshots,
    transcript: rec.transcript ?? null, chapters: rec.chapters ?? null,
    audio_path: audioPath, audio_mime: rec.audioMime ?? null, shared: false,
  }).select('*').single()

  if (error || !data) { console.error('saveRecording failed', error); return null }
  return rowToRecording(data as Row, true)
}

/** All recordings owned by the signed-in user, newest first. */
export async function listMine(ownerId: string): Promise<Recording[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('recordings').select('*').eq('owner', ownerId).order('created_at', { ascending: false })
  if (error) { console.error('listMine failed', error); return [] }
  return (data as Row[]).map((r) => rowToRecording(r, true))
}

/** Load any single recording the user is allowed to see (own or shared). */
export async function getById(id: string): Promise<Recording | null> {
  if (!supabase) return null
  const { data, error } = await supabase.from('recordings').select('*').eq('id', id).single()
  if (error || !data) return null
  const { data: u } = await supabase.auth.getUser()
  return rowToRecording(data as Row, u?.user?.id === (data as Row).owner)
}

export async function setShared(id: string, shared: boolean): Promise<boolean> {
  if (!supabase) return false
  const { error } = await supabase.from('recordings').update({ shared }).eq('id', id)
  return !error
}

export async function deleteRemote(rec: Recording): Promise<void> {
  if (!supabase) return
  if (rec.audioPath) await supabase.storage.from(BUCKET).remove([rec.audioPath])
  await supabase.from('recordings').delete().eq('id', rec.id)
}

/** Ask the server for a short-lived signed URL to a recording's audio. */
export async function fetchAudioUrl(id: string): Promise<string | null> {
  if (!supabase) return null
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) return null
  try {
    const res = await fetch('/api/recordings/audio-url', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ recordingId: id }),
    })
    if (!res.ok) return null
    const j = await res.json()
    return j.url ?? null
  } catch {
    return null
  }
}

/** Extract a recording id (uuid) from a pasted share link or raw id. */
export function parseShareLink(text: string): string | null {
  const m = text.trim().match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  return m ? m[0] : null
}

export function shareLinkFor(id: string): string {
  return `${window.location.origin}${window.location.pathname}#rec=${id}`
}
