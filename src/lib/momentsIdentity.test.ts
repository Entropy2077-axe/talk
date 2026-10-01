import { describe, expect, it } from 'vitest'
import { parseMomentsResponse } from './moments'

const expected = [{ posterId: 'poster-a', commenterIds: ['commenter-a', 'commenter-b'] }]

function payload(posterId = 'poster-a', commenterIds = ['commenter-a', 'commenter-b']) {
  return JSON.stringify({
    moments: [{
      posterId,
      content: '今天试了一杯新咖啡。',
      topicKey: '饮食-新咖啡',
      timeFrame: 'current',
      factBasis: '普通公开观察',
      imageKeyword: 'a cup of coffee on a wooden table',
      imageKind: 'object',
      includePoster: false,
      comments: commenterIds.map((authorId) => ({ authorId, content: `${authorId}的评论` })),
    }],
  })
}

describe('moment identity binding', () => {
  it('accepts a post and comments whose explicit identities match the selected cast', () => {
    expect(parseMomentsResponse(payload(), expected)?.[0].comments.map((comment) => comment.authorId)).toEqual(['commenter-a', 'commenter-b'])
  })

  it('rejects a post attributed to a different selected character', () => {
    expect(parseMomentsResponse(payload('poster-b'), expected)).toBeNull()
  })

  it('rejects comments whose authors were swapped by the model', () => {
    expect(parseMomentsResponse(payload('poster-a', ['commenter-b', 'commenter-a']), expected)).toBeNull()
  })

  it('forces person-centered images to include the publisher in the visual roster', () => {
    const parsed = parseMomentsResponse(JSON.stringify({
      moments: [{
        ...JSON.parse(payload()).moments[0],
        imageKind: 'portrait',
        includePoster: false,
        comments: [
          { authorId: 'commenter-a', content: 'A' },
          { authorId: 'commenter-b', content: 'B' },
        ],
      }],
    }), expected)
    expect(parsed?.[0].includePoster).toBe(true)
  })
})
