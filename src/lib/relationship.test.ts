import { describe, expect, it } from 'vitest'
import { relationshipLine } from './relationship'

describe('established relationship prompt consistency', () => {
  it('does not downgrade a lover to a generic friend at medium warmth', () => {
    const line = relationshipLine('恋人', '', 45)
    expect(line).toContain('恋人关系')
    expect(line).toContain('既有关系')
    expect(line).not.toContain('算得上是朋友')
  })

  it('keeps the ordinary friendship warmth wording for friends', () => {
    expect(relationshipLine('朋友', '', 45)).toContain('算得上是朋友')
  })
})
