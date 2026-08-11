import type { AppSettings, Contact, PromptModuleSettings, PromptPreset, SamplingParameters } from '../types'
import { createDefaultPromptModules, normalizePromptModules } from './promptModules'
import { db } from '../db/db'

export const SYSTEM_DEFAULT_PROMPT_PRESET_ID = 'system-default-prompt'

export function clonePromptModules(modules: PromptModuleSettings): PromptModuleSettings {
  return structuredClone(normalizePromptModules(modules))
}

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

export function systemDefaultPromptPreset(): PromptPreset {
  return {
    id: SYSTEM_DEFAULT_PROMPT_PRESET_ID,
    name: '默认提示词',
    modules: createDefaultPromptModules(),
    systemDefault: true,
    createdAt: 0,
    updatedAt: 0,
  }
}

export function normalizePromptPresets(value: unknown, legacyModules?: PromptModuleSettings): PromptPreset[] {
  const fallback = systemDefaultPromptPreset()
  const rows = Array.isArray(value) ? value : []
  const normalized = rows.flatMap((row): PromptPreset[] => {
    if (!row || typeof row !== 'object') return []
    const candidate = row as Partial<PromptPreset>
    if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string') return []
    return [{
      id: candidate.id,
      name: candidate.name.trim() || '未命名提示词',
      modules: normalizePromptModules(candidate.modules),
      sampling: normalizeSamplingParameters(candidate.sampling),
      systemDefault: candidate.id === SYSTEM_DEFAULT_PROMPT_PRESET_ID,
      createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : Date.now(),
      updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : Date.now(),
    }]
  })
  const withoutSystem = normalized.filter((preset) => preset.id !== SYSTEM_DEFAULT_PROMPT_PRESET_ID)
  if (rows.length === 0 && legacyModules) {
    const legacy = normalizePromptModules(legacyModules)
    if (JSON.stringify(legacy) !== JSON.stringify(fallback.modules)) {
      withoutSystem.unshift({ id: 'migrated-global-prompt', name: '原全局提示词', modules: legacy, createdAt: Date.now(), updatedAt: Date.now() })
    }
  }
  return [fallback, ...withoutSystem]
}

export function activePromptPreset(settings: Pick<AppSettings, 'promptPresets' | 'activePromptPresetId' | 'promptModules'>): PromptPreset {
  return settings.promptPresets?.find((preset) => preset.id === settings.activePromptPresetId)
    ?? settings.promptPresets?.[0]
    ?? { ...systemDefaultPromptPreset(), modules: clonePromptModules(settings.promptModules) }
}

export function promptModulesForContact(contact: Contact, settings: Pick<AppSettings, 'promptModules'>): PromptModuleSettings {
  return contact.promptModulesSnapshot ? normalizePromptModules(contact.promptModulesSnapshot) : normalizePromptModules(settings.promptModules)
}

/** One-time compatibility snapshot so future global edits never mutate legacy contacts. */
export async function ensureContactPromptSnapshots(settings: Pick<AppSettings, 'promptModules' | 'promptPresets' | 'activePromptPresetId'>): Promise<void> {
  const missing = await db.contacts.filter((contact) => !contact.promptModulesSnapshot).toArray()
  if (!missing.length) return
  const preset = activePromptPreset(settings)
  const now = Date.now()
  await db.transaction('rw', db.contacts, async () => {
    for (const contact of missing) await db.contacts.update(contact.id, {
      promptModulesSnapshot: clonePromptModules(settings.promptModules),
      promptPresetSourceId: preset.id,
      promptPresetSourceName: '升级前提示词',
      promptSnapshotUpdatedAt: now,
    })
  })
}
