import { describe, expect, it } from 'vitest'
import { lifeWindows } from './lifeSimulation'
import { customTraitWarmthModifier } from './relationship'
import { rankWorldbookEntries } from './worldbook'
import { customTraitsValidationError, hasOverlappingCustomTraitRules } from './contactCreator'

describe('life simulation windows', () => {
  it('uses bounded deterministic windows for long gaps', () => {
    const now = Date.now()
    const first = lifeWindows(now - 30 * 24 * 60 * 60 * 1000, now)
    expect(first.length).toBeLessThanOrEqual(30)
    expect(first).toEqual(lifeWindows(now - 30 * 24 * 60 * 60 * 1000, now))
  })
})

describe('worldbook and trait rules', () => {
  it('keeps permanent entries ahead of keyword matches', () => {
    const entry = (id: string, title: string, content: string, alwaysInclude = false) => ({ id, title, content, keywords: id === 'magic' ? ['魔法'] : [], enabled: true, alwaysInclude, priority: 10, createdAt: 1, updatedAt: 1 })
    expect(rankWorldbookEntries([entry('always', '基础规则', '所有人遵守', true), entry('magic', '魔法学院', '学院课程')], '去魔法学院').map((item) => item.entry.id)).toEqual(['always', 'magic'])
  })
  it('caps combined custom trait multipliers', () => {
    const traits = [{ id: 'x', name: 'x', meaning: 'x', rules: [{ id: 'r', minWarmth: -100, maxWarmth: 100, positiveMultiplier: 20, negativeMultiplier: 20, prompt: '' }] }]
    expect(customTraitWarmthModifier(traits, 2, 0)).toBe(20)
  })
  it('validates and detects overlapping creator trait rules', () => {
    const trait = { id: 'x', name: 'x', meaning: 'x', rules: [{ id: 'a', minWarmth: 0, maxWarmth: 50, positiveMultiplier: 1, negativeMultiplier: 1, prompt: '' }, { id: 'b', minWarmth: 40, maxWarmth: 80, positiveMultiplier: 1, negativeMultiplier: 1, prompt: '' }] }
    expect(hasOverlappingCustomTraitRules(trait)).toBe(true)
    expect(customTraitsValidationError([{ ...trait, name: '' }])).toContain('名称')
  })
})
