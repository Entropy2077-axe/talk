import { describe, expect, it } from 'vitest'
import type { AppSettings } from '../types'
import { buildMemoryUpdatePrompt } from './memory'
import { createDefaultPromptModules } from './promptModules'

function promptWithDisabled(disabled: Array<'memory' | 'relationship' | 'intent'>): string {
  const promptModules = createDefaultPromptModules()
  for (const id of disabled) promptModules[id].enabled = false
  return buildMemoryUpdatePrompt({
    settings: { promptModules } as AppSettings,
    existingFacts: '旧事实',
    existingStyle: '旧风格',
    existingPlansText: '',
    warmth: 20,
    currentTimeText: '现在',
  })
}

describe('shared memory/relationship/intent model prompt', () => {
  it('removes disabled module bodies and output fields independently', () => {
    const relationshipOnly = promptWithDisabled(['memory', 'intent'])
    expect(relationshipOnly).toContain('warmthDelta')
    expect(relationshipOnly).not.toContain('memoryItems')
    expect(relationshipOnly).not.toContain('"intents"')

    const memoryOnly = promptWithDisabled(['relationship', 'intent'])
    expect(memoryOnly).toContain('memoryItems')
    expect(memoryOnly).not.toContain('warmthDelta')
    expect(memoryOnly).not.toContain('"intents"')

    const intentOnly = promptWithDisabled(['memory', 'relationship'])
    expect(intentOnly).toContain('"intents"')
    expect(intentOnly).not.toContain('memoryItems')
    expect(intentOnly).not.toContain('warmthDelta')
  })

  it('skips the shared call when all three prompt modules are blocked', () => {
    expect(promptWithDisabled(['memory', 'relationship', 'intent'])).toBe('')
  })
})
