import 'dotenv/config'
import { context, trace, SpanStatusCode } from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node'

const PROJECT_NAME = process.env.ARIZE_PROJECT_NAME || 'ferbai-tutor'
const SPACE_ID = process.env.ARIZE_SPACE_ID
const API_KEY = process.env.ARIZE_API_KEY
const COLLECTOR_ENDPOINT = process.env.ARIZE_COLLECTOR_ENDPOINT || 'https://otlp.arize.com/v1/traces'

let tracingEnabled = false

const resource = resourceFromAttributes({
  'service.name': 'ferbai-backend',
  'service.namespace': 'ferbai',
  'openinference.project.name': PROJECT_NAME,
})

const spanProcessors = []

if (SPACE_ID && API_KEY) {
  const exporter = new OTLPTraceExporter({
    url: COLLECTOR_ENDPOINT,
    headers: {
      space_id: SPACE_ID,
      api_key: API_KEY,
    },
  })
  spanProcessors.push(new BatchSpanProcessor(exporter))
  tracingEnabled = true
  console.info(`[tracing] Arize exporter enabled. project=${PROJECT_NAME} endpoint=${COLLECTOR_ENDPOINT}`)
} else {
  console.info(`[tracing] Arize exporter disabled: set ARIZE_SPACE_ID and ARIZE_API_KEY to export traces. project=${PROJECT_NAME}`)
}

const provider = new NodeTracerProvider({ resource, spanProcessors })
provider.register()

export const tracer = trace.getTracer('ferbai-backend')

export function isTracingEnabled() {
  return tracingEnabled
}

export function truncate(value, limit = 4000) {
  if (value == null) return ''
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > limit ? `${text.slice(0, limit)}...` : text
}

export function getCurrentTraceId() {
  return trace.getSpan(context.active())?.spanContext()?.traceId || null
}

export function setSpanAttributes(span, attrs = {}) {
  if (!span || !attrs) return
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue
    if (Array.isArray(value)) {
      span.setAttribute(key, value.map((item) => String(item)))
    } else if (typeof value === 'object') {
      span.setAttribute(key, truncate(value))
    } else {
      span.setAttribute(key, value)
    }
  }
}

export function recordSpanError(span, err) {
  if (!span || !err) return
  span.recordException(err)
  span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message || String(err) })
}

export async function withSpan(name, attrs, fn) {
  return tracer.startActiveSpan(name, (span) => {
    setSpanAttributes(span, attrs)
    return Promise.resolve()
      .then(() => fn(span))
      .then((result) => {
        span.setStatus({ code: SpanStatusCode.OK })
        return result
      })
      .catch((err) => {
        recordSpanError(span, err)
        throw err
      })
      .finally(() => span.end())
  })
}

export function withSpanSync(name, attrs, fn) {
  return tracer.startActiveSpan(name, (span) => {
    setSpanAttributes(span, attrs)
    try {
      const result = fn(span)
      span.setStatus({ code: SpanStatusCode.OK })
      return result
    } catch (err) {
      recordSpanError(span, err)
      throw err
    } finally {
      span.end()
    }
  })
}
