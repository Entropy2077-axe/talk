import type { ElementType } from 'react'
import { useSettingsStore } from '../store/useSettingsStore'
import { shopModule } from './shop'
import { warehouseModule } from './warehouse'
import { worldviewModule } from './worldview'
import { knowledgeBaseModule } from './knowledgeBase'
import { relationshipModule } from './relationship'
import { personalityTraitsModule } from './personalityTraits'
import { proactiveChatModule } from './proactiveChat'
import { mindReadingModule } from './mindReading'
import { intentModule } from './intent'
import { selfIterationModule } from './selfIteration'
import { storyOutlineModule } from './storyOutline'
import { careerModule } from './career'
import { lifeSimulationModule } from './lifeSimulation'
import { saveLoadModule } from './saveLoad'
import { aiReplyAssistModule } from './aiReplyAssist'
import { realisticRepliesModule } from './realisticReplies'
import { promptModuleEditorModule } from './promptModuleEditor'
import type { FeatureModule, ParentModule } from './types'

// ---- parent modules (accordion groups in the UI) ----

export const PARENT_MODULES: ParentModule[] = [
  {
    id: 'character-soul',
    name: '角色灵魂',
    icon: '✨',
    description: '世界观、知识库、好感度、特色人格、心情系统、读心与AI内部意图',
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

export const ALL_MODULES: FeatureModule[] = [
  shopModule,
  warehouseModule,
  worldviewModule,
  knowledgeBaseModule,
  relationshipModule,
  personalityTraitsModule,
  proactiveChatModule,
  mindReadingModule,
  intentModule,
  selfIterationModule,
  storyOutlineModule,
  careerModule,
  lifeSimulationModule,
  saveLoadModule,
  aiReplyAssistModule,
  realisticRepliesModule,
  promptModuleEditorModule,
]

/** Modules that don't belong to any parent — shown as standalone toggles. */
export const STANDALONE_MODULES = ALL_MODULES.filter((m) => !m.parentId)

// ---- helpers ----

/** React hook: is a specific module enabled? */
export function useModuleEnabled(id: string): boolean {
  return useSettingsStore((s) => s.enabledModules.includes(id))
}

/** Non-reactive read for use outside React components (e.g. chat engine). */
export function isModuleEnabled(id: string): boolean {
  return useSettingsStore.getState().enabledModules.includes(id)
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
  const enabled = useSettingsStore.getState().enabledModules
  const seen = new Set<string>()
  const routes: { path: string; component: ElementType }[] = []
  for (const m of ALL_MODULES) {
    if (!enabled.includes(m.id)) continue
    for (const r of m.routes ?? []) {
      if (seen.has(r.path)) continue
      seen.add(r.path)
      routes.push(r)
    }
  }
  return routes
}

/** Get discover entries from all enabled modules. */
export function getEnabledDiscoverEntries(): { to: string; icon: string; label: string }[] {
  const enabled = useSettingsStore.getState().enabledModules
  const seen = new Set<string>()
  const entries: { to: string; icon: string; label: string }[] = []
  for (const m of ALL_MODULES) {
    if (!enabled.includes(m.id)) continue
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
  .filter((m) => m.id !== 'proactiveChat' && m.id !== 'mindReading' && m.id !== 'selfIteration' && m.id !== 'nuwaMode' && m.id !== 'lifeSimulation' && m.id !== 'realisticReplies' && m.id !== 'promptModuleEditor')
  .map((m) => m.id)
