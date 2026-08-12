import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContactGenerationInput, ContactGenerationTask } from '../types'
import { db } from '../db/db'
import { useSettingsStore } from '../store/useSettingsStore'

const streamRuntime = vi.hoisted(() => ({ active: 0, maxActive: 0, calls: 0 }))

vi.mock('./deepseek', () => ({
  chatCompletionText: vi.fn(),
}))

vi.mock('./personaAgentTools', () => ({
  generatePersonaWithTools: vi.fn(async () => {
    streamRuntime.active += 1
    streamRuntime.calls += 1
    streamRuntime.maxActive = Math.max(streamRuntime.maxActive, streamRuntime.active)
    try {
      await new Promise((resolve) => setTimeout(resolve, 20))
      const output = JSON.stringify({
        name: `队列角色${streamRuntime.calls}`, realName: '林澄', nickname: '阿澄', birthday: '2002-06-15',
        gender: '女', ageRange: '24岁', relationship: '朋友', occupation: '设计师',
        persona: '慢热但真诚的朋友，平时说话克制却很会观察细节，和用户相处时总会用行动表达关心。', personalityTrait: '猫系', mbti: 'INFP',
        speechSamples: ['你好'], personaProfile: { facts: [], boundaries: [], habits: [], behaviorAnchors: [] },
        pastExperiences: [], monthlySalary: 8000, schedule: [], avatarKeyword: 'portrait',
      })
      return { draft: JSON.parse(output), raw: output, usedNativeTools: true }
    } finally {
      streamRuntime.active -= 1
    }
  }),
}))

import { createContactGenerationTask, formatContactGenerationDiagnostic, stageLabel } from './contactGenerationTasks'

const taskInput: ContactGenerationInput = {
  personalityTags: ['温柔'], ageRange: '', gender: '', relationship: '', occupation: '', hobbies: [],
  personalityTrait: '', roleDescription: '', personaSetting: '', sharedHistory: '', avatar: '🙂',
  avatarManuallySet: false, initialWarmthMode: 'ai', relations: [], selectedWorldbookEntryIds: [],
  careerEnabled: false, relationshipEnabled: true, locationEnabled: false,
}

beforeEach(async () => {
  await db.contactGenerationTasks.clear()
  streamRuntime.active = 0
  streamRuntime.maxActive = 0
  streamRuntime.calls = 0
  useSettingsStore.getState().setSettings({ apiKey: 'queue-test-key' })
})

describe('contact generation task presentation', () => {
  it('uses immersive language without exposing generation internals', () => {
    expect(stageLabel('generating', 'immersive')).toBe('正在匹配合适的联系人')
    expect(stageLabel('validating', 'immersive')).toBe('正在确认对方资料')
  })

  it('copies a useful diagnostic without credentials or prompt content', () => {
    const task = {
      id: 'task-12345678', method: 'discovery', experienceMode: 'free', status: 'failed', stageLabel: '生成失败', provider: 'deepseek', baseUrl: 'https://example.test', model: 'model-a', utilityModel: 'model-b', attempt: 2, createdAt: 1, updatedAt: 2,
      input: { personalityTags: ['温柔'], ageRange: '', gender: '', relationship: '', occupation: '', hobbies: [], personalityTrait: '', roleDescription: 'private prompt', personaSetting: '', sharedHistory: '', avatar: '🙂', avatarManuallySet: false, initialWarmthMode: 'auto', relations: [], selectedWorldbookEntryIds: [], careerEnabled: false, relationshipEnabled: true, locationEnabled: false },
      error: { code: 'PERSONA_PARSE_FAILED', stage: 'validating', message: '人物资料格式不完整', technicalMessage: 'missing name', retryable: true, attempt: 2, occurredAt: 2 },
    } satisfies ContactGenerationTask
    const report = formatContactGenerationDiagnostic(task)
    expect(report).toContain('PERSONA_PARSE_FAILED')
    expect(report).toContain('missing name')
    expect(report).not.toContain('private prompt')
  })

  it('serializes rapidly queued generation tasks', async () => {
    await Promise.all([
      createContactGenerationTask({ method: 'precision', experienceMode: 'free', input: taskInput }),
      createContactGenerationTask({ method: 'precision', experienceMode: 'free', input: taskInput }),
    ])

    await vi.waitFor(async () => {
      expect(await db.contactGenerationTasks.where('status').equals('awaiting_review').count()).toBe(2)
    })
    expect(streamRuntime.calls).toBe(2)
    expect(streamRuntime.maxActive).toBe(1)
  })
})
