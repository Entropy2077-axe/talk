import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import type { Location } from '../types'

export const PRESET_LOCATIONS: { name: string; icon: string }[] = [
  { name: '家里', icon: '🏠' },
  { name: '公司/学校', icon: '🏢' },
  { name: '咖啡厅', icon: '☕' },
  { name: '餐厅', icon: '🍽️' },
  { name: '电影院', icon: '🎬' },
  { name: '公园', icon: '🌳' },
  { name: '酒吧', icon: '🍸' },
  { name: '健身房', icon: '💪' },
  { name: '图书馆', icon: '📚' },
  { name: '商场', icon: '🛍️' },
  { name: '海边', icon: '🏖️' },
  { name: 'KTV', icon: '🎤' },
]

/** Seeds the preset locations into the db once, so every location (preset or custom) is looked up the same way. */
export async function ensurePresetLocations(): Promise<void> {
  const all = await db.locations.toArray()
  if (all.some((l) => l.isPreset)) return
  const existingNames = new Set(all.map((l) => l.name))
  const toAdd: Location[] = PRESET_LOCATIONS.filter((p) => !existingNames.has(p.name)).map((p) => ({
    id: uuid(),
    name: p.name,
    icon: p.icon,
    isPreset: true,
  }))
  if (toAdd.length > 0) await db.locations.bulkAdd(toAdd)
}

export function locationLabel(loc: Location | undefined): string {
  if (!loc) return '未知地点'
  return `${loc.icon} ${loc.name}`
}

/** Looks up a location by name, creating a new custom one (with a generic pin icon) if it doesn't exist yet. */
export async function resolveOrCreateLocation(name: string): Promise<string> {
  const trimmed = name.trim()
  const existing = await db.locations.where('name').equals(trimmed).first()
  if (existing) return existing.id
  const id = uuid()
  await db.locations.add({ id, name: trimmed, icon: '📍', isPreset: false })
  return id
}
