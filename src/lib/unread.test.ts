import { describe, expect, it } from 'vitest'
import type { Message } from '../types'
import { unreadCountFor } from './unread'

const base: Message = { id: 'm', conversationId: 'c', role: 'assistant', type: 'text', content: 'hello', createdAt: 2 }

describe('unreadCountFor', () => {
  it('does not count system-presented turn illustrations as incoming chat messages', () => {
    const illustration: Message = {
      ...base,
      id: 'illustration',
      type: 'image',
      content: '[本轮配图]',
      image: { assetId: 'asset', presentation: 'illustration' },
      createdAt: 3,
    }
    expect(unreadCountFor(0, [base, illustration])).toBe(1)
  })
})
