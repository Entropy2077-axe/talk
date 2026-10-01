import { describe, expect, it } from 'vitest'
import type { Group } from '../types'
import { findImmediateLocationRequest, rollbackGroupMemory } from './groupChatEngine'

function group(memory: string, memoryTurnCount: number): Group {
  return {
    id: 'group',
    name: '测试群',
    avatar: '群',
    avatarColor: '#eee',
    memberContactIds: [],
    memory,
    memoryTurnCount,
    createdAt: 1,
  }
}

describe('group regeneration context rollback', () => {
  it('restores the exact memory snapshot for the rejected latest turn', () => {
    const result = rollbackGroupMemory(group('旧记忆\n[time] 不合格回复摘要', 4), {
      turnSummary: '不合格回复摘要',
      groupMemoryUpdate: {
        before: { memory: '旧记忆', memoryTurnCount: 3 },
        after: { memory: '旧记忆\n[time] 不合格回复摘要', memoryTurnCount: 4 },
      },
    })

    expect(result).toEqual({ memory: '旧记忆', memoryTurnCount: 3 })
  })

  it('removes only the rejected summary from legacy memory', () => {
    const result = rollbackGroupMemory(group('旧记忆\n[time] 不合格回复摘要\n[time] 后续有效记忆', 5), {
      turnSummary: '不合格回复摘要',
      groupMemoryUpdate: { memory: '旧记忆\n[time] 不合格回复摘要', memoryTurnCount: 4 },
    })

    expect(result).toEqual({ memory: '旧记忆\n[time] 后续有效记忆', memoryTurnCount: 4 })
  })
})

describe('group custom location commands', () => {
  it('matches a natural room name to a longer custom location name', () => {
    expect(findImmediateLocationRequest('让小林回卧室休息吧', [
      { id: 'living', name: '客厅' },
      { id: 'custom-bedroom', name: '我的卧室' },
    ])).toEqual({ locationId: 'custom-bedroom', locationName: '我的卧室' })
  })
})
