export type AiProviderId =
  | 'deepseek'
  | 'openai'
  | 'gemini'
  | 'anthropic'
  | 'xai'
  | 'qwen'
  | 'glm'
  | 'minimax'
  | 'kimi'
  | 'custom'

export interface AiProviderAdapter {
  id: AiProviderId
  label: string
  stability: 'stable' | 'experimental' | 'custom'
  defaultBaseUrl: string
  defaultVersionPath: string
  models: 'supported' | 'unknown'
  tokenParameter: 'max_tokens' | 'max_completion_tokens'
  responseFormat: 'supported' | 'ignored' | 'unknown'
  temperature: { min: number; max: number; omit?: boolean }
  thinking: 'deepseek' | 'reasoning_effort' | 'enable_thinking' | 'anthropic' | 'none'
  reasoningFields: string[]
  systemRole: 'native' | 'hoist'
}

export const AI_PROVIDERS: Record<AiProviderId, AiProviderAdapter> = {
  deepseek: { id: 'deepseek', label: 'DeepSeek', stability: 'stable', defaultBaseUrl: 'https://api.deepseek.com', defaultVersionPath: '', models: 'supported', tokenParameter: 'max_tokens', responseFormat: 'supported', temperature: { min: 0, max: 2 }, thinking: 'deepseek', reasoningFields: ['reasoning_content'], systemRole: 'native' },
  openai: { id: 'openai', label: 'OpenAI / GPT', stability: 'experimental', defaultBaseUrl: 'https://api.openai.com/v1', defaultVersionPath: '/v1', models: 'supported', tokenParameter: 'max_completion_tokens', responseFormat: 'supported', temperature: { min: 0, max: 2 }, thinking: 'reasoning_effort', reasoningFields: ['reasoning', 'reasoning_content'], systemRole: 'native' },
  gemini: { id: 'gemini', label: 'Google Gemini', stability: 'experimental', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultVersionPath: '/v1beta/openai', models: 'supported', tokenParameter: 'max_completion_tokens', responseFormat: 'supported', temperature: { min: 0, max: 2 }, thinking: 'reasoning_effort', reasoningFields: ['reasoning', 'reasoning_content', 'thought_summary'], systemRole: 'native' },
  anthropic: { id: 'anthropic', label: 'Anthropic Claude', stability: 'experimental', defaultBaseUrl: 'https://api.anthropic.com/v1', defaultVersionPath: '/v1', models: 'unknown', tokenParameter: 'max_tokens', responseFormat: 'ignored', temperature: { min: 0, max: 1, omit: true }, thinking: 'anthropic', reasoningFields: ['reasoning', 'reasoning_content'], systemRole: 'hoist' },
  xai: { id: 'xai', label: 'xAI Grok', stability: 'experimental', defaultBaseUrl: 'https://api.x.ai/v1', defaultVersionPath: '/v1', models: 'supported', tokenParameter: 'max_tokens', responseFormat: 'unknown', temperature: { min: 0, max: 2 }, thinking: 'reasoning_effort', reasoningFields: ['reasoning', 'reasoning_content'], systemRole: 'native' },
  qwen: { id: 'qwen', label: '阿里 Qwen', stability: 'experimental', defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultVersionPath: '/compatible-mode/v1', models: 'supported', tokenParameter: 'max_tokens', responseFormat: 'supported', temperature: { min: 0.01, max: 1 }, thinking: 'enable_thinking', reasoningFields: ['reasoning_content'], systemRole: 'native' },
  glm: { id: 'glm', label: '智谱 GLM', stability: 'experimental', defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultVersionPath: '/api/paas/v4', models: 'supported', tokenParameter: 'max_tokens', responseFormat: 'unknown', temperature: { min: 0.01, max: 1 }, thinking: 'none', reasoningFields: ['reasoning_content'], systemRole: 'native' },
  minimax: { id: 'minimax', label: 'MiniMax', stability: 'experimental', defaultBaseUrl: 'https://api.minimaxi.com/v1', defaultVersionPath: '/v1', models: 'unknown', tokenParameter: 'max_completion_tokens', responseFormat: 'unknown', temperature: { min: 0.01, max: 1 }, thinking: 'none', reasoningFields: ['reasoning_content'], systemRole: 'native' },
  kimi: { id: 'kimi', label: 'Moonshot / Kimi', stability: 'experimental', defaultBaseUrl: 'https://api.moonshot.cn/v1', defaultVersionPath: '/v1', models: 'supported', tokenParameter: 'max_tokens', responseFormat: 'unknown', temperature: { min: 0, max: 1 }, thinking: 'none', reasoningFields: ['reasoning_content'], systemRole: 'native' },
  custom: { id: 'custom', label: '自定义 OpenAI 兼容接口', stability: 'custom', defaultBaseUrl: '', defaultVersionPath: '/v1', models: 'supported', tokenParameter: 'max_tokens', responseFormat: 'unknown', temperature: { min: 0, max: 2 }, thinking: 'none', reasoningFields: ['reasoning_content', 'reasoning'], systemRole: 'native' },
}

export const AI_PROVIDER_OPTIONS = Object.values(AI_PROVIDERS)

function cleanUrl(input: string): URL {
  const value = input.trim()
  if (!/^https?:\/\//i.test(value)) throw new Error('Base URL 必须以 http:// 或 https:// 开头')
  const url = new URL(value)
  url.search = ''
  url.hash = ''
  url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '')
  return url
}

function collapseDuplicateVersions(pathname: string): string {
  let result = pathname
  result = result.replace(/\/(v\d+)(?:\/\1)+(?=\/|$)/gi, '/$1')
  result = result.replace(/(\/compatible-mode\/v1)(?:\/compatible-mode\/v1)+/gi, '$1')
  result = result.replace(/(\/v1beta\/openai)(?:\/v1beta\/openai)+/gi, '$1')
  return result
}

const KNOWN_VERSION_SUFFIX = /\/(?:v\d+|v1beta\/openai|compatible-mode\/v1|api\/paas\/v4)$/i

export function resolveChatCompletionsUrl(input: string, providerId: AiProviderId): string {
  const adapter = AI_PROVIDERS[providerId]
  const source = input.trim() || adapter.defaultBaseUrl
  if (!source) throw new Error('请填写 Base URL')
  const url = cleanUrl(source)
  let path = collapseDuplicateVersions(url.pathname)
  if (/\/chat\/completions$/i.test(path)) {
    url.pathname = path
    return url.toString().replace(/\/$/, '')
  }
  if (!path || path === '/') path = adapter.defaultVersionPath
  else if (!KNOWN_VERSION_SUFFIX.test(path) && providerId !== 'custom') {
    const defaultPath = adapter.defaultVersionPath
    if (defaultPath && !path.toLowerCase().endsWith(defaultPath.toLowerCase())) path += defaultPath
  }
  url.pathname = collapseDuplicateVersions(`${path.replace(/\/$/, '')}/chat/completions`)
  return url.toString().replace(/\/$/, '')
}

export function resolveModelsUrl(input: string, providerId: AiProviderId): string | null {
  const adapter = AI_PROVIDERS[providerId]
  if (adapter.models === 'unknown') return null
  const chatUrl = new URL(resolveChatCompletionsUrl(input, providerId))
  chatUrl.pathname = chatUrl.pathname.replace(/\/chat\/completions$/i, '/models')
  return chatUrl.toString().replace(/\/$/, '')
}

export function clampProviderTemperature(providerId: AiProviderId, value: number | undefined): number | undefined {
  const adapter = AI_PROVIDERS[providerId]
  if (adapter.temperature.omit) return undefined
  const candidate = Number.isFinite(value) ? Number(value) : 1
  return Math.min(adapter.temperature.max, Math.max(adapter.temperature.min, candidate))
}
