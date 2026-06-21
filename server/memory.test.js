import assert from 'node:assert/strict'
import {
  appendMemoryEvent,
  cosineSimilarity,
  finalizeAgent1Session,
  findSimilarSummaryMatches,
  getAgentMemoryPacket,
  writeAgent2ReviewMemory,
} from './memory.js'

assert.equal(cosineSimilarity([1, 0], [1, 0]), 1)
assert.equal(cosineSimilarity([1, 0], [0, 1]), 0)

const matches = findSimilarSummaryMatches([1, 0], [
  { summaryId: 'a', sessionId: 'old-a', embedding: [0.95, 0.05], rolling: 'close', topics: ['algebra'] },
  { summaryId: 'b', sessionId: 'old-b', embedding: [0.5, 0.5], rolling: 'far', topics: ['biology'] },
  { summaryId: 'c', sessionId: 'current', embedding: [1, 0], rolling: 'current', topics: ['algebra'] },
], { threshold: 0.9, limit: 3, excludeSessionId: 'current' })
assert.equal(matches.length, 1)
assert.equal(matches[0].summaryId, 'a')
assert(matches[0].score >= 0.9)

const previousEmbeddingsKey = process.env.EMBEDDINGS_API_KEY
const previousOpenAiKey = process.env.OPENAI_API_KEY
const previousEmbeddingsBackend = process.env.MEMORY_EMBEDDINGS_BACKEND
process.env.EMBEDDINGS_API_KEY = ''
process.env.OPENAI_API_KEY = ''
process.env.MEMORY_EMBEDDINGS_BACKEND = 'none'
const sessionId = `memory_test_${Date.now()}`
await appendMemoryEvent(sessionId, { type: 'user_message_received', payload: { text: 'Teach factoring quadratics' } })
await appendMemoryEvent(sessionId, { type: 'assistant_response_completed', payload: { text: 'Which two numbers multiply to 6 and add to 5?' } })
await writeAgent2ReviewMemory({
  sessionId,
  review: {
    verdict: 'needs_improvement',
    risks: ['The tutor should check understanding more often.'],
    recommendations: ['Ask the learner to explain the next step.'],
    evidence: {},
  },
  summary: 'Agent 2 review summary',
})
await finalizeAgent1Session({ sessionId, userId: 'test-user', metadata: { activeView: 'board' } })
const packet = await getAgentMemoryPacket(sessionId, { userId: 'test-user', queryText: 'factoring quadratics' })
assert.equal(packet.similarSummaries.length, 0)
assert(packet.agent2Guidance.some((item) => String(item.text).includes('check understanding')))
process.env.EMBEDDINGS_API_KEY = previousEmbeddingsKey
process.env.OPENAI_API_KEY = previousOpenAiKey
process.env.MEMORY_EMBEDDINGS_BACKEND = previousEmbeddingsBackend

console.log('memory tests passed')
process.exit(0)
