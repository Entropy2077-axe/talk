import type { ElementType } from 'react'
import { useSettingsStore } from '../store/useSettingsStore'
import { shopModule } from './shop'
import { warehouseModule } from './warehouse'
import { knowledgeBaseModule } from './knowledgeBase'
import { relationshipModule } from './relationship'
import { proactiveChatModule } from './proactiveChat'
import { mindReadingModule } from './mindReading'
import { speechModule } from './speech'
import { careerModule } from './career'
import { saveLoadModule } from './saveLoad'
import { realisticRepliesModule } from './realisticReplies'
import { locationModule } from './location'
import { directOutputModule } from './directOutput'
import type { FeatureModule, ParentModule } from './types'

// ---- parent modules (accordion groups in the UI) ----

export const PARENT_MODULES: ParentModule[] = [
  {
    id: 'character-soul',
    name: '角色灵魂',
    icon: '✨',
    description: '世界观、资料库、好感度、心情系统与读心',
  },
  {
    id: 'chat-assist',
    name: '聊天辅助',
    icon: '🛠️',
    description: 'AI自主行为等辅助能力',
  },
  {
    id: 'more-interaction',
    name: '更多互动',
    icon: '🎁',
    description: '商城购物与仓库赠送',
  },
]

// ---- registry ----
// Every module gets listed here. When you add a new module, import it above
// and add it to this array — that's the only registration step needed.

/** Always available foundations. They deliberately do not appear as switches. */
export const PERMANENT_MODULES: FeatureModule[] = [knowledgeBaseModule]

/** User-toggleable modules shown on the Modules page. */
export const ALL_MODULES: FeatureModule[] = [
  shopModule,
  warehouseModule,
  relationshipModule,
  proactiveChatModule,
  mindReadingModule,
  speechModule,
  careerModule,
  saveLoadModule,
  realisticRepliesModule,
  locationModule,
  directOutputModule,
]

/** Every registered module, including foundations that have no switch. */
export const REGISTERED_MODULES: FeatureModule[] = [...PERMANENT_MODULES, ...ALL_MODULES]

/** Modules that don't belong to any parent — shown as standalone toggles. */
export const STANDALONE_MODULES = ALL_MODULES.filter((m) => !m.parentId)

export const IMMERSIVE_RESTRICTED_MODULES = new Set(['location', 'mindReading'])

export function isModuleAllowedInExperienceMode(id: string, mode = useSettingsStore.getState().experienceMode): boolean {
  return mode !== 'immersive' || !IMMERSIVE_RESTRICTED_MODULES.has(id)
}

type ModuleState = Pick<ReturnType<typeof useSettingsStore.getState>, 'enabledModules' | 'experienceMode'>

function moduleEffectivelyEnabled(id: string, state: ModuleState = useSettingsStore.getState()): boolean {
  if (id === 'knowledgeBase') return true
  if (state.experienceMode === 'immersive' && id === 'realisticReplies') return true
  const effectiveId = id === 'worldview' ? 'saveLoad' : id
  return isModuleAllowedInExperienceMode(effectiveId, state.experienceMode) && (state.enabledModules.includes(effectiveId) || (id === 'worldview' && state.enabledModules.includes('worldview')))
}

// ---- helpers ----

/** React hook: is a specific module enabled? */
export function useModuleEnabled(id: string): boolean {
  return useSettingsStore((s) => id === 'knowledgeBase' || (s.experienceMode === 'immersive' && id === 'realisticReplies'
    ? true
    : isModuleAllowedInExperienceMode(id === 'worldview' ? 'saveLoad' : id, s.experienceMode) && (s.enabledModules.includes(id === 'worldview' ? 'saveLoad' : id) || (id === 'worldview' && s.enabledModules.includes('worldview')))))
}

/** Non-reactive read for use outside React components (e.g. chat engine). */
export function isModuleEnabled(id: string): boolean {
  return moduleEffectivelyEnabled(id)
}

/**
 * Build the linkApps list the chat engine should inject into the system
 * prompt. Starts from the standard constant, then filters out any entries
 * whose owning module is disabled.
 */
const MODULE_LINK_APP_OWNERS: Record<string, string> = {
  shop: 'shop',
  work: 'career',
}

export function getEnabledLinkApps(
  baseLinkApps: { app: string; desc: string }[],
): { app: string; desc: string }[] {
  return baseLinkApps.filter((la) => {
    const owner = MODULE_LINK_APP_OWNERS[la.app]
    if (!owner) return true
    return isModuleEnabled(owner)
  })
}

/**
 * Get the set of unique routes from enabled modules, deduplicating by path.
 */
export function getEnabledRoutes(): { path: string; component: ElementType }[] {
  const seen = new Set<string>()
  const routes: { path: string; component: ElementType }[] = []
  for (const m of REGISTERED_MODULES) {
    if (!moduleEffectivelyEnabled(m.id)) continue
    for (const r of m.routes ?? []) {
      if (seen.has(r.path)) continue
      seen.add(r.path)
      routes.push(r)
    }
  }
  return routes
}

/** Get discover entries from all enabled modules. */
export function getEnabledDiscoverEntries(state: ModuleState = useSettingsStore.getState()): { to: string; icon: string; label: string }[] {
  const seen = new Set<string>()
  const entries: { to: string; icon: string; label: string }[] = []
  for (const m of REGISTERED_MODULES) {
    if (!moduleEffectivelyEnabled(m.id, state)) continue
    for (const e of m.discoverEntries ?? []) {
      if (seen.has(e.to + e.label)) continue
      seen.add(e.to + e.label)
      entries.push(e)
    }
  }
  return entries
}

// ---- defaults ----

/** Every module is on by default except opt-in background/debug modules. */
export const DEFAULT_ENABLED_MODULES: string[] = ALL_MODULES
  .filter((m) => m.id !== 'proactiveChat' && m.id !== 'mindReading' && m.id !== 'realisticReplies' && m.id !== 'directOutput')
  .map((m) => m.id)
