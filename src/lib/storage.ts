// Thin localStorage wrapper for API keys, custom base URLs, and the last
// selected model. Everything stays on the user's machine — no server.

import { PROVIDERS } from './providers'

const KEY_PREFIX = 'ferbai:key:'
const URL_PREFIX = 'ferbai:url:'
const SELECTION_KEY = 'ferbai:selection'

function safeGet(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function safeSet(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    /* private mode / quota — ignore */
  }
}

export function getApiKey(providerId: string): string {
  return safeGet(KEY_PREFIX + providerId)
}

export function setApiKey(providerId: string, value: string): void {
  safeSet(KEY_PREFIX + providerId, value.trim())
}

export function getBaseUrl(providerId: string): string {
  const stored = safeGet(URL_PREFIX + providerId)
  if (stored) return stored
  return PROVIDERS.find((p) => p.id === providerId)?.defaultBaseUrl ?? ''
}

export function setBaseUrl(providerId: string, value: string): void {
  safeSet(URL_PREFIX + providerId, value.trim())
}

export function getSelection(fallback: string): string {
  return safeGet(SELECTION_KEY) || fallback
}

export function setSelection(value: string): void {
  safeSet(SELECTION_KEY, value)
}
