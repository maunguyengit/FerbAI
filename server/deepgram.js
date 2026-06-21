// Server-side Deepgram. The real API key stays here (env) and never reaches the
// browser. Live transcription is relayed through our own WebSocket
// (/api/deepgram/stream) so it works with any transcription-capable key — no
// browser token minting required (which needs scopes many keys don't have).

import { createClient } from '@deepgram/sdk'

const apiKey = process.env.DEEPGRAM_API_KEY
export const deepgramEnabled = !!apiKey

const dg = deepgramEnabled ? createClient(apiKey) : null
export const dgClient = dg

// live transcription options for the audio relay (no encoding → Deepgram
// auto-detects the webm/opus container the browser's MediaRecorder produces).
export const LIVE_OPTIONS = {
  model: 'nova-2',
  language: 'en',
  smart_format: true,
  punctuate: true,
  interim_results: true,
  endpointing: 250,
}
