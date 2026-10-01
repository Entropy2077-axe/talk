import type { AiApiConfig, AppSettings, SamplingParameters } from '../types'
import { AI_PROVIDERS, type AiProviderId } from './aiProviders'

const PROVIDERS = new Set<AiProviderId>(Object.keys(AI_PROVIDERS) as AiProviderId[])

export function normalizeSamplingParameters(value: unknown): SamplingParameters {
  const input = value && typeof value === 'object' ? value as Partial<SamplingParameters> : {}
  const temperature = Number(input.temperature)
  const topP = Number(input.topP)
  const topK = Number(input.topK)
  return {
    ...(Number.isFinite(temperature) ? { temperature: Math.min(2, Math.max(0, temperature)) } : {}),
    ...(Number.isFinite(topP) ? { topP: Math.min(1, Math.max(0, topP)) } : {}),
    ...(Number.isFinite(topK) && topK >= 1 ? { topK: Math.floor(topK) } : {}),
  }
}

export function legacyAiApiConfig(settings: Pick<AppSettings, 'aiProvider' | 'apiKey' | 'baseUrl' | 'model' | 'utilityModel'>, sampling?: unknown): AiApiConfig {
  const provider = PROVIDERS.has(settings.aiProvider) ? settings.aiProvider : 'deepseek'
  return { id: 'legacy-primary-api', name: '当前 API 配置', provider, apiKey: settings.apiKey ?? '', baseUrl: settings.baseUrl ?? '', model: settings.model ?? '', utilityModel: settings.utilityModel ?? '', sampling: normalizeSamplingParameters(sampling), createdAt: 0, updatedAt: Date.now() }
}

export function normalizeAiApiConfigs(value: unknown, legacy: Pick<AppSettings, 'aiProvider' | 'apiKey' | 'baseUrl' | 'model' | 'utilityModel'>, legacySampling?: unknown): AiApiConfig[] {
  const rows = Array.isArray(value) ? value : []
  const result = rows.flatMap((item): AiApiConfig[] => {
    if (!item || typeof item !== 'object') return []
    const row = item as Partial<AiApiConfig>
    if (typeof row.id !== 'string' || !row.id || !PROVIDERS.has(row.provider as AiProviderId)) return []
    return [{ id: row.id, name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : '未命名 API', provider: row.provider as AiProviderId, apiKey: typeof row.apiKey === 'string' ? row.apiKey : '', baseUrl: typeof row.baseUrl === 'string' ? row.baseUrl : '', model: typeof row.model === 'string' ? row.model : '', utilityModel: typeof row.utilityModel === 'string' ? row.utilityModel : '', sampling: normalizeSamplingParameters(row.sampling), createdAt: typeof row.createdAt === 'number' ? row.createdAt : Date.now(), updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : Date.now() }]
  })
  return result.length ? result : [legacyAiApiConfig(legacy, legacySampling)]
}

export function savedAiApiConfigs(settings: Pick<AppSettings, 'aiApiConfigs' | 'aiProvider' | 'apiKey' | 'baseUrl' | 'model' | 'utilityModel' | 'promptPresets' | 'activePromptPresetId'>): AiApiConfig[] {
  const legacySampling = (settings.promptPresets?.find((preset) => preset.id === settings.activePromptPresetId) as { sampling?: unknown } | undefined)?.sampling
  return normalizeAiApiConfigs(settings.aiApiConfigs, settings, legacySampling)
}

export function activeAiApiConfig(settings: Parameters<typeof savedAiApiConfigs>[0] & Pick<AppSettings, 'activeAiApiConfigId'>): AiApiConfig {
  const configs = savedAiApiConfigs(settings)
  return configs.find((config) => config.id === settings.activeAiApiConfigId) ?? configs[0]
}

export function legacyFieldsForApiConfig(config: AiApiConfig): Pick<AppSettings, 'aiProvider' | 'apiKey' | 'baseUrl' | 'model' | 'utilityModel'> {
  return { aiProvider: config.provider, apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model, utilityModel: config.utilityModel }
}
