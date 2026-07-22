import { describe, expect, it } from 'vitest'
import { REALISTIC_REPLY_MAX_DELAY_MS, realisticReplyDelayMs } from './replyTiming'

describe('realistic reply timing', () => {
  it('stays disabled at zero and bounded to five minutes when enabled', () => {
    expect(realisticReplyDelayMs(false, 1)).toBe(0)
    expect(realisticReplyDelayMs(true, 0)).toBe(0)
    expect(realisticReplyDelayMs(true, 1)).toBe(REALISTIC_REPLY_MAX_DELAY_MS)
    expect(realisticReplyDelayMs(true, 0.5)).toBe(Math.round(REALISTIC_REPLY_MAX_DELAY_MS / 2))
  })
})
