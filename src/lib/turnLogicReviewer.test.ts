import { describe, expect, it } from 'vitest'
import { parseTurnLogicReview } from './turnLogicReviewer'

describe('turn logic reviewer protocol', () => {
  it('accepts a valid compact verdict', () => {
    expect(parseTurnLogicReview('{"valid":true,"reason":""}')).toEqual({
      valid: true,
      reason: '',
    })
  })

  it('extracts a JSON verdict from harmless surrounding text', () => {
    expect(parseTurnLogicReview('结果：{"valid":false,"reason":"混淆了两名群成员的身份"}')).toEqual({
      valid: false,
      reason: '混淆了两名群成员的身份',
    })
  })

  it('fails closed when the reviewer protocol is malformed', () => {
    expect(parseTurnLogicReview('不是JSON')).toEqual({
      valid: false,
      reason: '逻辑审查模型没有返回有效JSON',
    })
  })
})
