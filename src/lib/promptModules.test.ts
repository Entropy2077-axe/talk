import { describe, expect, it } from 'vitest'
import {
  createDefaultPromptModules,
  getPromptTemplate,
  normalizePromptModules,
  renderPromptTemplate,
  unknownPromptPlaceholders,
} from './promptModules'

describe('original prompt templates', () => {
  it('renders legal placeholders without leaving an overlay prompt behind', () => {
    expect(renderPromptTemplate('角色={{persona}}；好感={{warmth}}', { persona: '冷静', warmth: 42 }))
      .toBe('角色=冷静；好感=42')
  })

  it('rejects unknown placeholders while allowing legal placeholders to be removed', () => {
    expect(unknownPromptPlaceholders('relationship', 'chat', '{{relationshipContext}} {{notAllowed}}'))
      .toEqual(['notAllowed'])
    expect(unknownPromptPlaceholders('relationship', 'chat', '完全不使用动态变量'))
      .toEqual([])
  })

  it('drops the legacy overlay schema and only migrates the old global style', () => {
    const migrated = normalizePromptModules({
      chat: { enabled: false, prompt: 'WRONG_OVERLAY' },
      relationship: { enabled: false, prompt: 'WRONG_RELATIONSHIP_OVERLAY' },
    }, 'LEGACY_STYLE')

    expect(migrated.chat.enabled).toBe(true)
    expect(migrated.chat.templates.style).toBe('LEGACY_STYLE')
    expect(JSON.stringify(migrated)).not.toContain('WRONG_OVERLAY')
    expect(JSON.stringify(migrated)).not.toContain('WRONG_RELATIONSHIP_OVERLAY')
  })

  it('returns the edited original template globally and omits a blocked module', () => {
    const promptModules = createDefaultPromptModules()
    promptModules.relationship.templates.chat = 'GLOBAL_SENTINEL {{relationshipContext}}'
    expect(getPromptTemplate({ promptModules }, 'relationship', 'chat', { relationshipContext: 'DYNAMIC' }))
      .toBe('GLOBAL_SENTINEL DYNAMIC')

    promptModules.relationship.enabled = false
    expect(getPromptTemplate({ promptModules }, 'relationship', 'chat', { relationshipContext: 'DYNAMIC' }))
      .toBeNull()
  })

  it('restores defaults from the actual registry texts', () => {
    const defaults = createDefaultPromptModules()
    expect(defaults.worldview.templates.privateRuntime).toContain('正史硬约束')
    expect(defaults.chat.templates.groupMain).toContain('模拟真实群聊')
    expect(defaults.nuwaMode.templates.persona).toContain('女娲初稿模式')
  })

  it('keeps Nuwa polishing editable after completion was removed', () => {
    const defaults = createDefaultPromptModules()
    expect(defaults.nuwaMode.templates.assist).toBeUndefined()
    expect(defaults.nuwaMode.templates.polish).toContain('{{roleDescription}}')
    expect(getPromptTemplate({ promptModules: defaults }, 'nuwaMode', 'polish', {
      existingPersona: '保留这段',
      roleDescription: '补充边界',
    })).toContain('保留这段')
  })
})
