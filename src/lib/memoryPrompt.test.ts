import { describe, expect, it } from 'vitest'
import type { AppSettings } from '../types'
import { buildMemoryUpdatePrompt } from './memory'
import { createDefaultPromptModules } from './promptModules'

function promptWithDisabled(disabled: Array<'memory' | 'relationship'>): string {
  const promptModules = createDefaultPromptModules()
  for (const id of disabled) promptModules[id].enabled = false
  return buildMemoryUpdatePrompt({
    settings: { promptModules, enabledModules: ['relationship'] } as AppSettings,
    existingFacts: '旧事实',
    existingStyle: '旧风格',
    existingPlansText: '',
    warmth: 20,
    currentTimeText: '现在',
  })
}

describe('shared memory/relationship model prompt', () => {
  it('removes disabled module bodies and output fields independently', () => {
    const relationshipOnly = promptWithDisabled(['memory'])
    expect(relationshipOnly).toContain('warmthDelta')
    expect(relationshipOnly).not.toContain('memoryItems')
    expect(relationshipOnly).not.toContain('"intents"')

    const memoryOnly = promptWithDisabled(['relationship'])
    expect(memoryOnly).toContain('memoryItems')
    expect(memoryOnly).not.toContain('warmthDelta')
    expect(memoryOnly).not.toContain('"intents"')

  })

  it('skips the shared call when both prompt modules are blocked', () => {
    expect(promptWithDisabled(['memory', 'relationship'])).toBe('')
  })

  it('omits feature-gated fields when the feature switch is off', () => {
    const promptModules = createDefaultPromptModules()
    const prompt = buildMemoryUpdatePrompt({
      settings: { promptModules, enabledModules: [] } as unknown as AppSettings,
      existingFacts: '旧事实',
      existingStyle: '旧风格',
      existingPlansText: '',
      warmth: 20,
      currentTimeText: '现在',
    })
    expect(prompt).toContain('memoryItems')
    expect(prompt).not.toContain('warmthDelta')
    expect(prompt).not.toContain('"intents"')
  })
})
