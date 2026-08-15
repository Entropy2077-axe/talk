import { describe, expect, it } from 'vitest'
import { resolveChatCompletionsUrl, resolveModelsUrl } from './aiProviders'

describe('AI provider URL normalization', () => {
  it.each([
    'https://api.example.com',
    'https://api.example.com/',
    'https://api.example.com/v1',
    'https://api.example.com/v1/',
    'https://api.example.com/v1/chat/completions',
    'https://api.example.com/chat/completions',
  ])('normalizes supported custom forms: %s', (input) => {
    expect(resolveChatCompletionsUrl(input, 'custom')).toBe(
      input.includes('/chat/completions')
        ? input.replace(/\/$/, '')
        : `https://api.example.com${input.includes('/v1') ? '/v1' : '/v1'}/chat/completions`,
    )
  })

  it('removes query, hash, and duplicated version paths', () => {
    expect(resolveChatCompletionsUrl(' https://api.example.com/v1/v1/chat/completions?x=1#y ', 'custom'))
      .toBe('https://api.example.com/v1/chat/completions')
  })

  it('uses provider-specific paths and models capability', () => {
    expect(resolveChatCompletionsUrl('https://generativelanguage.googleapis.com', 'gemini'))
      .toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions')
    expect(resolveModelsUrl('https://api.anthropic.com/v1', 'anthropic')).toBeNull()
    expect(resolveModelsUrl('https://api.example.com/v1/chat/completions', 'custom')).toBe('https://api.example.com/v1/models')
  })
})
