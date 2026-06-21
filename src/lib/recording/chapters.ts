import type { Chapter, TranscriptWord } from './types'

// Ask the server (Claude) to segment a finished transcript into chapters.
export async function generateChapters(transcript: TranscriptWord[] | undefined): Promise<Chapter[]> {
  if (!transcript || !transcript.length) return []
  try {
    const res = await fetch('/api/chapters', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transcript: transcript.map((w) => ({ w: w.w, start: w.start })) }),
    })
    if (!res.ok) return []
    const j = await res.json()
    const chapters: Chapter[] = Array.isArray(j.chapters) ? j.chapters : []
    // always anchor a first chapter at 0
    if (chapters.length && chapters[0].t > 1500) chapters.unshift({ t: 0, title: 'Intro' })
    return chapters
  } catch {
    return []
  }
}
