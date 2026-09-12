import { describe, expect, it } from 'vitest'
import { parseOptimizedSchedule, scheduleDistributionIssue } from './scheduleOptimization'

const block = (dayOfWeek: number, includeLocation = true) => ({
  dayOfWeek,
  startHour: 9,
  endHour: 18,
  phoneAccess: 'unavailable',
  ...(includeLocation ? { location: '办公室' } : {}),
  locationId: 'office-floor',
  activity: '上班',
})

const locations = [{ id: 'office-floor', name: '办公室', description: '', access: 'public' as const, sortOrder: 1, kind: 'room' as const, createdAt: 1, updatedAt: 1 }]

describe('schedule optimization parsing', () => {
  it('accepts protocol-compliant blocks that only contain a map locationId', () => {
    const [result] = parseOptimizedSchedule(JSON.stringify({ schedule: [block(1, false)] }), locations)
    expect(result).toMatchObject({ locationId: 'office-floor', location: '办公室' })
  })

  it('keeps usable partial weekly schedules for the user to review', () => {
    expect(parseOptimizedSchedule(JSON.stringify({ schedule: [block(1), block(2)] }), locations)).toHaveLength(2)
  })

  it('accepts a bare array from compatible JSON-mode providers', () => {
    expect(parseOptimizedSchedule(JSON.stringify([block(1)]), locations)).toHaveLength(1)
  })

  it('accepts an explicitly empty schedule when the player asks to clear it', () => {
    expect(parseOptimizedSchedule('{"schedule":[]}', locations)).toEqual([])
  })

  it('allows a detailed schedule with more than 28 valid entries', () => {
    const detailed = Array.from({ length: 35 }, (_, index) => ({
      ...block(index % 7),
      startHour: index % 5,
      endHour: index % 5 + 1,
      activity: `安排${index}`,
    }))
    expect(parseOptimizedSchedule(JSON.stringify({ schedule: detailed }), locations)).toHaveLength(35)
  })

  it('removes exact duplicate entries returned by the AI', () => {
    const repeated = block(1)
    expect(parseOptimizedSchedule(JSON.stringify({ schedule: [repeated, repeated] }), locations)).toHaveLength(1)
  })

  it('rejects a response that contains no valid schedule blocks', () => {
    expect(() => parseOptimizedSchedule('{"schedule":[{"dayOfWeek":9}]}', locations)).toThrow('没有返回带有效地图地点的日程')
  })

  it('rejects blocks whose locationId is not a current concrete map location', () => {
    expect(() => parseOptimizedSchedule(JSON.stringify({ schedule: [{ ...block(1, false), locationId: 'made-up-place' }] }), locations)).toThrow('没有返回带有效地图地点的日程')
  })

  it('flags a weekly plan that puts every meaningful arrangement on one day', () => {
    expect(scheduleDistributionIssue([block(1), block(1), block(1)])).toBe('3 项日程不能全部堆在同一天')
  })

  it('accepts a sufficiently distributed weekly plan', () => {
    expect(scheduleDistributionIssue([block(1), block(2), block(3), block(4), block(5), block(6), block(0)])).toBeNull()
  })
})
