const port = process.env.PORT || 8787
const url = `http://localhost:${port}/api/health`
const timeoutMs = Number(process.env.DEV_API_WAIT_TIMEOUT_MS || 15000)
const startedAt = Date.now()

while (Date.now() - startedAt < timeoutMs) {
  try {
    const res = await fetch(url)
    if (res.ok) process.exit(0)
  } catch {
    // API is still starting.
  }
  await new Promise((resolve) => setTimeout(resolve, 250))
}

console.error(`[dev] API did not become ready at ${url} within ${timeoutMs}ms.`)
process.exit(1)
