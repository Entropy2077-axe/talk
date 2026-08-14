import { describe, expect, it } from 'vitest'
import {
  createDefaultPromptModules,
  featureActive,
  getPromptTemplate,
  normalizePromptModules,
  PROMPT_MODULE_DEFINITIONS,
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

  it('upgrades retired templates saved inside contact snapshots', () => {
    const migrated = normalizePromptModules({
      chat: {
        enabled: true,
        templates: {
          identity: '身份、人设、用户补充约束与结构化人设锚点 {{hardPersona}}',
          groupMain: '热闹程度：{{energyLevel}}；AI互聊={{aiChatterMode}}',
          style: '保留用户自己编辑的风格',
        },
      },
    })

    expect(migrated.chat.templates.identity).toContain('{{persona}}')
    expect(migrated.chat.templates.identity).not.toContain('结构化人设')
    expect(migrated.chat.templates.groupMain).toContain('模拟真实群聊')
    expect(migrated.chat.templates.groupMain).not.toContain('energyInstruction')
    expect(migrated.chat.templates.style).toBe('保留用户自己编辑的风格')
  })

  it('repairs the retired shared-history placeholder before contact editing', () => {
    const migrated = normalizePromptModules({
      memory: {
        enabled: true,
        templates: { chat: '【记忆】\n{{memoryContext}}\n{{sharedHistory}}\n{{recentMemories}}' },
      },
    })
    expect(migrated.memory.templates.chat).not.toContain('{{sharedHistory}}')
    expect(unknownPromptPlaceholders('memory', 'chat', migrated.memory.templates.chat)).toEqual([])
  })

  it('ships no unknown placeholders in any current default template', () => {
    for (const definition of PROMPT_MODULE_DEFINITIONS) {
      for (const item of definition.templates) {
        expect(unknownPromptPlaceholders(definition.id, item.id, item.defaultTemplate), `${definition.id}/${item.id}`).toEqual([])
      }
    }
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

  it('requires both switches for feature-gated prompt modules', () => {
    const promptModules = createDefaultPromptModules()
    const settings = { promptModules, enabledModules: ['saveLoad'] }
    expect(featureActive(settings, 'worldview')).toBe(true)

    settings.enabledModules = []
    expect(featureActive(settings, 'worldview')).toBe(false)

    settings.enabledModules = ['saveLoad']
    promptModules.worldview.enabled = false
    expect(featureActive(settings, 'worldview')).toBe(false)
  })

  it('keeps prompt-only modules independent of the feature registry', () => {
    const promptModules = createDefaultPromptModules()
    expect(featureActive({ promptModules, enabledModules: [] }, 'chat')).toBe(true)
    promptModules.chat.enabled = false
    expect(featureActive({ promptModules, enabledModules: [] }, 'chat')).toBe(false)
  })
})
