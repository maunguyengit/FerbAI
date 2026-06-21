const QUESTION_RE = /\?/g
const TURN_RE = /^\s*(student|client|learner|user|tutor|agent|assistant|teacher)\s*:/i
const POSITIVE_RE = /\b(good|great|nice|correct|exactly|well done|you got|that's right)\b/gi
const UNDERSTANDING_RE =
  /\b(does that make sense|what do you think|why|how did you get|can you explain|check your understanding|try|your turn|walk me through)\b/gi
const SCAFFOLD_RE = /\b(hint|step|first|next|because|notice|let's break|simpler|example|compare|diagram|draw|board)\b/gi
const ASSESSMENT_RE = /\b(question|quiz|practice|solve|try this|what is|why is|how would|can you|tell me)\b/gi
const BOARD_RE = /\b(board|diagram|draw|shown|sketch|equation|graph)\b/gi

function countMatches(text, pattern) {
  return (text.match(pattern) || []).length
}

function clampScore(score) {
  return Math.min(5, Math.max(1, score))
}

function labelFor(score) {
  if (score >= 5) return 'excellent'
  if (score >= 4) return 'strong'
  if (score >= 3) return 'adequate'
  if (score >= 2) return 'weak'
  return 'poor'
}

function countTurns(transcript) {
  const counts = { student: 0, tutor: 0, other: 0 }
  for (const line of transcript.split(/\r?\n/)) {
    const match = TURN_RE.exec(line)
    if (!match) continue
    const speaker = match[1].toLowerCase()
    if (['student', 'client', 'learner', 'user'].includes(speaker)) counts.student += 1
    else if (['tutor', 'agent', 'assistant', 'teacher'].includes(speaker)) counts.tutor += 1
    else counts.other += 1
  }
  return counts
}

function sentenceSnippets(text, pattern, limit = 3) {
  const snippets = []
  const chunks = text.replace(/\n/g, ' ').split(/(?<=[.!?])\s+/)
  for (const chunk of chunks) {
    const clean = chunk.trim()
    pattern.lastIndex = 0
    if (clean && pattern.test(clean)) snippets.push(clean.slice(0, 220))
    if (snippets.length >= limit) break
  }
  return snippets
}

function dimension(name, score, rationale) {
  return { name, score, label: labelFor(score), rationale }
}

export function messagesToTranscript(messages = []) {
  return messages
    .filter((message) => message && message.text && !message.pending && !message.error)
    .map((message) => {
      const speaker = message.role === 'assistant' ? 'Tutor' : 'Student'
      return `${speaker}: ${String(message.text).trim()}`
    })
    .join('\n\n')
}

export function scoreTutorTranscript({ transcript, boardState = '', lessonGoal = '' }) {
  const normalized = String(transcript || '').trim()
  if (!normalized) throw new Error('Transcript is empty.')

  const turns = countTurns(normalized)
  const wordCount = normalized.split(/\s+/).filter(Boolean).length
  const questionCount = countMatches(normalized, QUESTION_RE)
  const encouragementHits = countMatches(normalized, POSITIVE_RE)
  const understandingHits = countMatches(normalized, UNDERSTANDING_RE)
  const scaffoldHits = countMatches(normalized, SCAFFOLD_RE)
  const assessmentHits = countMatches(normalized, ASSESSMENT_RE)
  const boardMentions = countMatches(normalized, BOARD_RE)
  const hasBoardState = !!String(boardState || '').trim()
  const hasGoal = !!String(lessonGoal || '').trim()

  const interactionScore = clampScore(2 + Math.min(2, Math.floor(questionCount / 3)) + Math.min(1, Math.floor(understandingHits / 2)))
  const diagnosisScore = clampScore(2 + Math.min(2, Math.floor(understandingHits / 2)) + Math.min(1, Math.floor(assessmentHits / 4)))
  const scaffoldingScore = clampScore(2 + Math.min(3, Math.floor(scaffoldHits / 3)))
  const boardScore = clampScore(1 + (hasBoardState ? 2 : 0) + Math.min(2, boardMentions))
  const affectScore = clampScore(2 + Math.min(2, Math.floor(encouragementHits / 2)) + (turns.student > 0 ? 1 : 0))
  const goalScore = clampScore(2 + (hasGoal ? 1 : 0) + Math.min(2, Math.floor(assessmentHits / 5)))

  const dimensions = [
    dimension('student engagement', interactionScore, 'Rewards questions, turn-taking, and prompts that invite the student to reason.'),
    dimension('diagnosis of understanding', diagnosisScore, 'Checks whether the tutor surfaced misconceptions instead of only explaining.'),
    dimension('scaffolding and pedagogy', scaffoldingScore, 'Looks for stepwise hints, examples, simplification, and reasoning support.'),
    dimension('board grounding', boardScore, 'Checks whether the tutor used the visible board or drawing state meaningfully.'),
    dimension('supportive tone', affectScore, 'Rewards constructive encouragement without letting praise replace instruction.'),
    dimension('lesson-goal alignment', goalScore, 'Checks whether the exchange appears tied to a clear learning objective.'),
  ]

  const averageScore = Math.round((dimensions.reduce((sum, item) => sum + item.score, 0) / dimensions.length) * 100) / 100
  const verdict = averageScore >= 4 ? 'effective' : averageScore >= 3 ? 'needs_improvement' : 'ineffective'
  const strengths = []
  const risks = []
  const recommendations = []

  if (questionCount >= 4) {
    strengths.push('The tutor asks multiple questions instead of relying only on exposition.')
  } else {
    risks.push('The tutor may be over-explaining without enough student participation.')
    recommendations.push('Add short checks for understanding after each major step.')
  }

  if (scaffoldHits >= 5) {
    strengths.push('The transcript contains concrete scaffolding language and stepwise support.')
  } else {
    risks.push('The tutoring may need more explicit hints, examples, or decomposition.')
    recommendations.push('Break the task into smaller steps and ask the student to complete each step.')
  }

  if (hasBoardState && boardMentions === 0) {
    risks.push('Board state was provided, but the tutor does not clearly reference it.')
    recommendations.push('Ground feedback in the board: point to the drawing, equation, or diagram state.')
  } else if (hasBoardState) {
    strengths.push('The tutor appears to connect instruction to visible board or diagram context.')
  }

  if (encouragementHits === 0) {
    recommendations.push("Add specific encouragement tied to the student's reasoning, not generic praise.")
  }

  return {
    verdict,
    averageScore,
    dimensions,
    strengths,
    risks,
    recommendations,
    evidence: {
      wordCount,
      turnCounts: turns,
      questionCount,
      encouragementHits,
      understandingCheckHits: understandingHits,
      scaffoldingHits: scaffoldHits,
      assessmentHits,
      boardMentions,
      sampleUnderstandingChecks: sentenceSnippets(normalized, UNDERSTANDING_RE),
      sampleScaffolding: sentenceSnippets(normalized, SCAFFOLD_RE),
    },
    note: 'Local heuristic analysis, not an Arize task result.',
  }
}

export function formatTutorReview(review) {
  const lines = [
    `Tutor review: ${review.verdict.replace('_', ' ')} (${review.averageScore}/5)`,
    '',
    'Dimensions:',
    ...review.dimensions.map((item) => `- ${item.name}: ${item.score}/5 (${item.label})`),
    '',
    'Risks:',
    ...(review.risks.length ? review.risks.map((item) => `- ${item}`) : ['- No major risks found by the local heuristic.']),
    '',
    'Recommendations:',
    ...(review.recommendations.length ? review.recommendations.map((item) => `- ${item}`) : ['- Keep collecting richer lesson evidence for scoring.']),
    '',
    review.note,
  ]
  return lines.join('\n')
}
