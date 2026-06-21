// E2E test: many tutoring sessions -> embeddings -> semantic retrieval.
// Drives the live API on :8787. Isolated under a unique userId per run.
const BASE = process.env.E2E_BASE || 'http://localhost:8787'
const USER = `e2e-${Date.now().toString(36)}`

let pass = 0, fail = 0
const log = (...a) => console.log(...a)
function check(name, cond, detail = '') {
  if (cond) { pass++; log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  })
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { body = text }
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text.slice(0, 300)}`)
  return body
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 7 realistic, distinct tutoring sessions (a ~20-min span of usage, compressed).
const SESSIONS = [
  { key: 'algebra-factoring', view: 'board', goal: 'Factor quadratic expressions',
    turns: [
      ['Can you teach me how to factor quadratics like x^2 + 5x + 6?', 'Sure. We need two numbers that multiply to 6 and add to 5. Which pair works?'],
      ['2 and 3?', 'Exactly. So x^2 + 5x + 6 factors into (x + 2)(x + 3). Try x^2 + 7x + 12 yourself.'],
      ['(x + 3)(x + 4)', "Correct, well done. Notice 3 and 4 multiply to 12 and add to 7."],
    ] },
  { key: 'biology-photosynthesis', view: 'board', goal: 'Understand photosynthesis',
    turns: [
      ['How does photosynthesis work in plants?', 'Photosynthesis converts sunlight, water, and carbon dioxide into glucose and oxygen. Where in the cell does this happen?'],
      ['The chloroplast?', 'Right. The light reactions occur in the thylakoid membranes, producing ATP and NADPH. What do you think the Calvin cycle uses those for?'],
      ['To build sugar?', 'Exactly — the Calvin cycle fixes CO2 into glucose using that ATP and NADPH.'],
    ] },
  { key: 'cs-binary-search', view: 'board', goal: 'Learn binary search',
    turns: [
      ['Explain the binary search algorithm.', 'Binary search finds a target in a sorted array by repeatedly halving the search range. What is its time complexity?'],
      ['O(log n)?', 'Correct. Each step discards half the remaining elements. Can you walk me through searching for 7 in [1,3,5,7,9]?'],
      ['Check middle 5, go right, find 7', 'Nicely done — that is the core of the algorithm.'],
    ] },
  { key: 'history-french-revolution', view: 'notes', goal: 'Causes of the French Revolution',
    turns: [
      ['What caused the French Revolution?', 'Several factors: financial crisis, social inequality among the estates, and Enlightenment ideas. Which estate paid most of the taxes?'],
      ['The third estate?', 'Right. The commoners bore the tax burden while the nobility and clergy were largely exempt, fueling resentment by 1789.'],
    ] },
  { key: 'calculus-derivatives', view: 'graph', goal: 'Differentiate polynomials',
    turns: [
      ['How do I take the derivative of x^3 + 2x?', 'Use the power rule: bring down the exponent and reduce it by one. What do you get for x^3?'],
      ['3x^2', 'Correct. And the derivative of 2x is 2, so the answer is 3x^2 + 2.'],
    ] },
  { key: 'chemistry-stoichiometry', view: 'board', goal: 'Balance reactions and mole ratios',
    turns: [
      ['Help me with stoichiometry and mole ratios.', 'Stoichiometry uses the balanced equation to relate amounts. In 2H2 + O2 -> 2H2O, how many moles of water from 4 moles of H2?'],
      ['4 moles of water?', 'Exactly — the 2:2 ratio between H2 and H2O means moles of water equals moles of hydrogen.'],
    ] },
  { key: 'spanish-preterite', view: 'notes', goal: 'Conjugate Spanish preterite tense',
    turns: [
      ['How do I conjugate regular -ar verbs in the preterite?', 'For -ar verbs, drop -ar and add endings: é, aste, ó, amos, asteis, aron. How would you say "I spoke" from hablar?'],
      ['hablé', 'Perfecto. And "they spoke" would be hablaron.'],
    ] },
]

// Semantic queries: deliberately reworded so success requires meaning, not keywords.
const QUERIES = [
  { q: 'How do I split a trinomial into the product of two binomials?', expect: 'algebra-factoring' },
  { q: 'Explain how green plants turn light from the sun into stored chemical energy.', expect: 'biology-photosynthesis' },
  { q: 'What is the cost of looking up a value in an ordered list by repeatedly halving it?', expect: 'cs-binary-search' },
  { q: 'Why did the common people of France revolt against the monarchy in the late 1700s?', expect: 'history-french-revolution' },
  { q: 'Find the slope function of a cubic polynomial using the power rule.', expect: 'calculus-derivatives' },
]

async function run() {
  log(`\n=== FerbAI memory E2E — embeddings ===`)
  log(`userId=${USER}  base=${BASE}\n`)

  // 1) Drive + finalize every session.
  log('--- Phase 1: simulate sessions, append events, finalize (generates embeddings) ---')
  const sessionIds = {}
  for (const s of SESSIONS) {
    const sid = `${USER}__${s.key}`
    sessionIds[s.key] = sid
    for (const [user, assistant] of s.turns) {
      await api(`/api/memory/${sid}/events`, { method: 'POST', body: JSON.stringify({ type: 'user_message_received', payload: { text: user } }) })
      await api(`/api/memory/${sid}/events`, { method: 'POST', body: JSON.stringify({ type: 'assistant_response_completed', payload: { text: assistant } }) })
    }
    const t0 = Date.now()
    const { summary } = await api(`/api/memory/session/${sid}/end`, { method: 'POST', body: JSON.stringify({ userId: USER, metadata: { activeView: s.view, lessonGoal: s.goal } }) })
    check(`finalize ${s.key}`, !!summary?.id, `summaryId=${summary?.id} in ${Date.now() - t0}ms, topics=[${(summary?.entities||[]).map(e=>e.text).slice(0,5).join(', ')}]`)
  }

  await sleep(500) // let the vector index settle

  // 2) Semantic retrieval with reworded queries.
  log('\n--- Phase 2: semantic retrieval (reworded queries, threshold 0.2 to inspect ranking) ---')
  let topHits = 0
  for (const { q, expect } of QUERIES) {
    // Query from a brand-new session id so excludeSessionId never hides a real match.
    const querySid = `${USER}__query__${expect}`
    const params = new URLSearchParams({ userId: USER, queryText: q, threshold: '0.2', similarityLimit: '7' })
    const packet = await api(`/api/memory/${querySid}/packet?${params.toString()}`)
    const sims = packet.similarSummaries || []
    const expectedSid = sessionIds[expect]
    const top = sims[0]
    const isTop = top && top.sessionId === expectedSid
    if (isTop) topHits++
    const ranking = sims.slice(0, 3).map((m) => `${m.sessionId.replace(USER + '__', '')}=${m.score}`).join('  ')
    check(`retrieve "${expect}"`, isTop, `top: ${ranking || '(none)'}`)
    // Confirm the matching session also clearly outranks an unrelated one.
    const expectedScore = sims.find((m) => m.sessionId === expectedSid)?.score
    if (expectedScore != null) {
      const others = sims.filter((m) => m.sessionId !== expectedSid).map((m) => m.score)
      const maxOther = others.length ? Math.max(...others) : 0
      check(`  ${expect} outranks unrelated`, expectedScore > maxOther, `match=${expectedScore} > best-other=${maxOther}`)
    }
  }

  // 3) Negative control: a query unrelated to every session should not produce a high-confidence hit at 0.9.
  log('\n--- Phase 3: negative control + threshold behavior ---')
  const offTopic = 'What are the best practices for changing a car tire on the highway?'
  const strict = await api(`/api/memory/${USER}__query__none/packet?` + new URLSearchParams({ userId: USER, queryText: offTopic, threshold: '0.9', similarityLimit: '7' }).toString())
  check('off-topic query yields no 0.9 match', (strict.similarSummaries || []).length === 0, `got ${ (strict.similarSummaries||[]).length } matches`)

  // Same off-topic query, loose threshold — whatever comes back should score low.
  const loose = await api(`/api/memory/${USER}__query__none2/packet?` + new URLSearchParams({ userId: USER, queryText: offTopic, threshold: '0.2', similarityLimit: '7' }).toString())
  const looseTop = (loose.similarSummaries || [])[0]
  check('off-topic best score stays modest', !looseTop || looseTop.score < 0.45, `top=${looseTop ? looseTop.score : 'none'}`)

  // 4) Cross-session isolation: a different userId must not see this run's memories.
  const otherUser = await api(`/api/memory/${USER}__iso/packet?` + new URLSearchParams({ userId: `someone-else-${Date.now().toString(36)}`, queryText: QUERIES[0].q, threshold: '0.2', similarityLimit: '7' }).toString())
  check('memories are isolated per userId', (otherUser.similarSummaries || []).length === 0, `cross-user matches=${(otherUser.similarSummaries||[]).length}`)

  log(`\n=== RESULT: ${pass} passed, ${fail} failed  (semantic top-1 hits: ${topHits}/${QUERIES.length}) ===\n`)
  process.exit(fail ? 1 : 0)
}

run().catch((err) => { console.error('E2E ERROR:', err); process.exit(2) })
