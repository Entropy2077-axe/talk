import { describe, expect, it } from 'vitest'
import { ALL_MODULES, DEFAULT_ENABLED_MODULES } from './index'

describe('conversation illustration module', () => {
  it('is registered under chat assistance and remains opt-in by default', () => {
    const module = ALL_MODULES.find((candidate) => candidate.id === 'conversationIllustration')
    expect(module?.parentId).toBe('chat-assist')
    expect(DEFAULT_ENABLED_MODULES).not.toContain('conversationIllustration')
  })
})
