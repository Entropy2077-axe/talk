import { describe, expect, it } from 'vitest'
import { eligiblePostersForRefresh, momentNoveltyIssue, publicMomentSceneIssue } from './moments'
import type { Contact } from '../types'

describe('moment novelty guard', () => {
  it('rejects an exact post even when whitespace and punctuation differ', () => {
    expect(momentNoveltyIssue('今晚加班修图，窗外就下雨了。戴上耳机倒也不错！', [
      { content: '今晚加班修图 窗外就下雨了 戴上耳机倒也不错' },
    ])).toContain('完全相同')
  })

  it('allows unrelated posts from the same person', () => {
    expect(momentNoveltyIssue('下班路上买到了惦记很久的面包，热乎乎的。', [
      { content: '今晚加班修图，窗外就下雨了，戴上耳机倒也不错。' },
    ])).toBeNull()
  })

  it('rejects the same semantic topic even when the wording changes', () => {
    expect(momentNoveltyIssue('老师讲到最后一页时脑子已经转不动了。', [
      { content: '今天的课排得太满，回家只想躺着。', topicKey: '学校-课堂疲劳' },
    ], '课堂疲劳')).toContain('同一主题')
  })

  it('rejects obvious private-chat wording in a public post', () => {
    expect(publicMomentSceneIssue('主人，今天也要早点回来哦。')).toContain('私聊对象')
    expect(publicMomentSceneIssue('给家里泡了壶茶，难得有个安静的下午。')).toBeNull()
  })

  it('manual refresh bypasses the posting cooldown', () => {
    const now = new Date(2026, 8, 12, 12).getTime()
    const contact = { id: 'student', lastMomentAt: now - 1_000, schedule: [] } as unknown as Contact
    expect(eligiblePostersForRefresh([contact], now, false)).toEqual([])
    expect(eligiblePostersForRefresh([contact], now, true)).toEqual([contact])
  })
})
