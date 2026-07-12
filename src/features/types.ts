import type { ElementType } from 'react'

export interface FeatureModule {
  id: string
  name: string
  icon: string // emoji
  description: string
  /** Parent module id — sub-modules are grouped under a parent in the UI */
  parentId?: string
  /** Route definitions — only registered when module is enabled */
  routes?: { path: string; component: ElementType }[]
  /** Discover page entries — only shown when module is enabled */
  discoverEntries?: { to: string; icon: string; label: string }[]
  /** Prompt link apps (mini-programs) — only included when module is enabled */
  linkApps?: { app: string; desc: string }[]
}

/** A grouping of related sub-modules — not toggleable itself, just a UI accordion. */
export interface ParentModule {
  id: string
  name: string
  icon: string
  description: string
}
