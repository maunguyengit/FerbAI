// Provider + model catalog for the chatbot dropdown.
//
// `type` drives the request shape:
//   - 'anthropic' → POST {baseUrl}/v1/messages   (x-api-key, anthropic-version)
//   - 'openai'    → POST {baseUrl}/chat/completions (Bearer key, OpenAI schema)
//
// Base URLs are editable in Settings, so an OpenAI-compatible gateway
// (OpenRouter, a self-hosted proxy, the OpenCode Go endpoint, etc.) can be
// pointed anywhere without code changes.

export type ProviderType = 'anthropic' | 'openai'

export interface ModelDef {
  id: string
  label: string
  vision: boolean
}

export interface Provider {
  id: string
  label: string
  type: ProviderType
  defaultBaseUrl: string
  keyHint: string
  models: ModelDef[]
}

export const PROVIDERS: Provider[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    type: 'anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    keyHint: 'sk-ant-…',
    models: [
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', vision: true },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', vision: true },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', vision: true },
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    type: 'openai',
    defaultBaseUrl: 'https://api.deepseek.com',
    keyHint: 'sk-…',
    models: [
      { id: 'deepseek-chat', label: 'DeepSeek V3 (chat)', vision: false },
      { id: 'deepseek-reasoner', label: 'DeepSeek R1 (reasoner)', vision: false },
    ],
  },
  {
    id: 'opencode-go',
    label: 'OpenCode Go plan',
    type: 'openai',
    defaultBaseUrl: 'https://opencode.ai/v1',
    keyHint: 'your OpenCode Go key',
    models: [
      { id: 'minimax-m3', label: 'MiniMax M3', vision: true },
      { id: 'kimi-k2.6', label: 'Kimi K2.6', vision: true },
      { id: 'glm-4.6', label: 'GLM', vision: true },
      { id: 'qwen-max', label: 'Qwen', vision: true },
    ],
  },
]

export function getProvider(id: string): Provider | undefined {
  return PROVIDERS.find((p) => p.id === id)
}

export function getModel(providerId: string, modelId: string): ModelDef | undefined {
  return getProvider(providerId)?.models.find((m) => m.id === modelId)
}

/** "providerId::modelId" round-trips for the <select> value. */
export function encodeSelection(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`
}

export function decodeSelection(value: string): { providerId: string; modelId: string } {
  const [providerId, modelId] = value.split('::')
  return { providerId, modelId }
}

export const DEFAULT_SELECTION = encodeSelection('claude-code', 'claude-opus-4-8')
