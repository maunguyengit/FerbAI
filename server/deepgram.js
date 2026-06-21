// Server-side Deepgram. The real API key stays here (env). The browser never
// sees it — instead it asks for a short-lived (60s) scoped temporary key to open
// Deepgram's live transcription WebSocket directly.

import { createClient } from '@deepgram/sdk'

const apiKey = process.env.DEEPGRAM_API_KEY
export const deepgramEnabled = !!apiKey

const dg = deepgramEnabled ? createClient(apiKey) : null

let projectIdCache = null
async function getProjectId() {
  if (projectIdCache) return projectIdCache
  const { result, error } = await dg.manage.getProjects()
  if (error) throw new Error(error.message || 'deepgram getProjects failed')
  const id = result?.projects?.[0]?.project_id
  if (!id) throw new Error('No Deepgram project found for this key.')
  projectIdCache = id
  return id
}

/** Mint a short-lived key the browser can use for live streaming. */
export async function mintTempKey() {
  if (!dg) throw new Error('Deepgram not configured.')
  const projectId = await getProjectId()
  const { result, error } = await dg.manage.createProjectKey(projectId, {
    comment: 'chalkai-live',
    scopes: ['usage:write'],
    time_to_live_in_seconds: 60,
  })
  if (error) throw new Error(error.message || 'deepgram createProjectKey failed')
  return { key: result.key, expiresIn: 60 }
}

/** Transcribe a pre-recorded audio buffer (fallback / batch). */
export async function transcribeBuffer(buf, mime) {
  if (!dg) throw new Error('Deepgram not configured.')
  const { result, error } = await dg.listen.prerecorded.transcribeFile(buf, {
    model: 'nova-2', smart_format: true, punctuate: true, mimetype: mime,
  })
  if (error) throw new Error(error.message || 'deepgram transcribe failed')
  return result
}
