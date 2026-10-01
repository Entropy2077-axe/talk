import { getEnabledDiscoverEntries, isModuleAllowedInExperienceMode } from '../features'
import type { AppSettings } from '../types'

export interface DiscoverEntry { to: string; icon: string; label: string }
export interface DiscoverGroup { id: string; name: string; entries: DiscoverEntry[] }

/** Fixed group and item order, shared by mobile and desktop. */
export function discoverGroups(settings: Pick<AppSettings, 'enabledModules' | 'experienceMode'>): DiscoverGroup[] {
  const entries = getEnabledDiscoverEntries(settings)
  const lifeOrder = ['/save-load', '/work', '/locations', '/shop', '/warehouse']
  if (settings.enabledModules.includes('saveLoad') && isModuleAllowedInExperienceMode('saveLoad', settings.experienceMode)) {
    entries.push({ to: '/save-load', icon: '💾', label: '选择世界' })
  }
  const life = lifeOrder.flatMap((to) => entries.filter((entry) => entry.to === to))
  const other = entries.filter((entry) => !lifeOrder.includes(entry.to))
  return [
    { id: 'social', name: '社交', entries: [
      { to: '/moments', icon: '📸', label: '朋友圈' },
      { to: '/social-inbox', icon: '🔔', label: '互动收件箱' },
      { to: '/relationships', icon: 'network', label: '关系网' },
    ] },
    { id: 'life', name: '世界与生活', entries: life },
    { id: 'other', name: '其他已启用功能', entries: other },
  ].filter((group) => group.entries.length > 0)
}

export function readDiscoverExpanded(): Record<string, boolean> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem('talk-discover-groups') ?? '{}')
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {}
    return Object.fromEntries(Object.entries(saved).filter(([id, value]) => ['life', 'other'].includes(id) && typeof value === 'boolean'))
  } catch { return {} }
}

export function saveDiscoverExpanded(expanded: Record<string, boolean>) {
  try { localStorage.setItem('talk-discover-groups', JSON.stringify(expanded)) } catch { /* Storage may be unavailable; navigation still works. */ }
}
