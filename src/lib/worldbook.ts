import { db } from '../db/db'
import { useSettingsStore } from '../store/useSettingsStore'
import type { WorldbookEntry } from '../types'

export interface WorldbookMatch { entry: WorldbookEntry; score: number }

let lastLoggedMatchSignature = ''
let lastLoggedMatchAt = 0

function terms(text: string): string[] {
  const normalized = text.toLowerCase()
  const latin = normalized.match(/[a-z0-9_-]{2,}/g) ?? []
  const han = normalized.match(/[\u3400-\u9fff]{2,}/g) ?? []
  const pairs = han.flatMap((word) => Array.from({ length: Math.max(0, word.length - 1) }, (_, i) => word.slice(i, i + 2)))
  return [...new Set([...latin, ...han, ...pairs])]
}

export function rankWorldbookEntries(entries: WorldbookEntry[], query: string): WorldbookMatch[] {
  const queryText = query.toLowerCase()
  const queryTerms = terms(query)
  return entries.filter((e) => e.enabled).map((entry) => {
    if (entry.alwaysInclude) return { entry, score: 10000 + entry.priority }
    let score = entry.priority
    for (const keyword of entry.keywords) if (keyword.trim() && queryText.includes(keyword.trim().toLowerCase())) score += 80
    const title = entry.title.toLowerCase()
    const content = entry.content.toLowerCase()
    for (const term of queryTerms) {
      if (title.includes(term)) score += 12
      if (content.includes(term)) score += 2
    }
    return { entry, score }
  }).filter((m) => m.entry.alwaysInclude || m.score > m.entry.priority)
    .sort((a, b) => b.score - a.score || b.entry.priority - a.entry.priority || b.entry.updatedAt - a.entry.updatedAt)
}

export async function retrieveWorldbookTrace(query: string, opts: { maxEntries?: number; maxChars?: number } = {}) {
  const maxEntries = opts.maxEntries ?? 6
  const maxChars = opts.maxChars ?? 5000
  const matches = rankWorldbookEntries(await db.worldbookEntries.toArray(), query).slice(0, maxEntries)
  const selected: WorldbookMatch[] = []
  let used = 0
  for (const match of matches) {
    const blockLength = match.entry.title.length + match.entry.content.length + 8
    if (selected.length > 0 && used + blockLength > maxChars) continue
    selected.push(match)
    used += blockLength
  }
  if (useSettingsStore.getState().adminModeEnabled && selected.length) {
    const signature = selected.map((m) => `${m.entry.id}:${m.score}`).join('|')
    const now = Date.now()
    if (signature !== lastLoggedMatchSignature || now - lastLoggedMatchAt > 30_000) {
      lastLoggedMatchSignature = signature
      lastLoggedMatchAt = now
      console.log('[worldbook] 命中:', selected.map((m) => `${m.entry.title}(${m.score})`).join('、'))
    }
  }
  return { text: selected.map((m) => `【${m.entry.title}】\n${m.entry.content}`).join('\n\n'), matches: selected }
}

export async function retrieveWorldbookContext(query: string, opts: { maxEntries?: number; maxChars?: number } = {}) {
  return (await retrieveWorldbookTrace(query, opts)).text
}

export async function ensureLegacyWorldviewMigrated(): Promise<void> {
  const settings = useSettingsStore.getState()
  if (settings.worldbookMigrationCompleted) return
  const content = settings.worldview.trim()
  if (content) {
    await db.worldbookEntries.put({
      id: 'legacy-worldview', title: '旧世界设定', content, keywords: [], enabled: true,
      alwaysInclude: true, priority: 100, createdAt: Date.now(), updatedAt: Date.now(),
    })
  }
  settings.setSettings({ worldview: '', worldbookMigrationCompleted: true })
}
