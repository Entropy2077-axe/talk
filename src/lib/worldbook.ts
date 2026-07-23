import { db } from '../db/db'
import { useSettingsStore } from '../store/useSettingsStore'
import type { WorldbookCollection, WorldbookEntry } from '../types'

export interface WorldbookMatch { entry: WorldbookEntry; score: number }
export interface WorldbookRetrievalOptions { maxEntries?: number; maxChars?: number; includeHighPriorityFallback?: boolean }

let lastLoggedMatchSignature = ''
let lastLoggedMatchAt = 0

function terms(text: string): string[] {
  const normalized = text.toLowerCase()
  const latin = normalized.match(/[a-z0-9_-]{2,}/g) ?? []
  const han = normalized.match(/[\u3400-\u9fff]{2,}/g) ?? []
  const pairs = han.flatMap((word) => Array.from({ length: Math.max(0, word.length - 1) }, (_, i) => word.slice(i, i + 2)))
  return [...new Set([...latin, ...han, ...pairs])]
}

function isPermanent(entry: WorldbookEntry) {
  return entry.keywords.filter((keyword) => keyword.trim()).length === 0
}

export function rankWorldbookEntries(entries: WorldbookEntry[], query: string): WorldbookMatch[] {
  const queryText = query.toLowerCase()
  const queryTerms = terms(query)
  return entries.filter((entry) => entry.enabled).map((entry) => {
    if (entry.foundationalWorldview) return { entry, score: 20000 + entry.priority }
    if (isPermanent(entry)) return { entry, score: 10000 + entry.priority }
    let score = entry.priority
    for (const keyword of entry.keywords) if (keyword.trim() && queryText.includes(keyword.trim().toLowerCase())) score += 80
    const title = entry.title.toLowerCase()
    const content = entry.content.toLowerCase()
    for (const term of queryTerms) {
      if (title.includes(term)) score += 12
      if (content.includes(term)) score += 2
    }
    return { entry, score }
  }).filter((match) => match.entry.foundationalWorldview || isPermanent(match.entry) || match.score > match.entry.priority)
    .sort((a, b) => b.score - a.score || b.entry.priority - a.entry.priority || b.entry.updatedAt - a.entry.updatedAt)
}

async function enabledEntries(): Promise<{ entries: WorldbookEntry[]; collections: Map<string, WorldbookCollection> }> {
  const [collectionsList, entries] = await Promise.all([db.worldbookCollections.toArray(), db.worldbookEntries.toArray()])
  const collections = new Map(collectionsList.map((collection) => [collection.id, collection]))
  return {
    collections,
    entries: entries.filter((entry) => entry.enabled && (collections.get(entry.collectionId)?.enabled ?? entry.collectionId === 'default-worldbook')),
  }
}

function renderEntry(entry: WorldbookEntry, collections: Map<string, WorldbookCollection>) {
  const collection = collections.get(entry.collectionId)
  const label = collection?.name ? `${collection.name} / ${entry.title}` : entry.title
  return `【${label}】\n${entry.content}`
}

export async function foundationalWorldviewText() {
  const { entries, collections } = await enabledEntries()
  const foundational = entries.filter((entry) => entry.foundationalWorldview).sort((a, b) => b.priority - a.priority || (a.sourceOrder ?? 0) - (b.sourceOrder ?? 0))
  if (!foundational.length) return ''
  return `【底层世界观——全局最高优先级正史】\n以下规则默认约束所有主要内容生成，不得被现实常识、普通世界书或自由发挥覆盖。\n${foundational.map((entry) => renderEntry(entry, collections)).join('\n\n')}`
}

export async function retrieveWorldbookTrace(query: string, opts: WorldbookRetrievalOptions = {}) {
  const maxEntries = opts.maxEntries ?? 6
  const maxChars = opts.maxChars ?? 5000
  const { entries, collections } = await enabledEntries()
  const ranked = rankWorldbookEntries(entries, query)
  const foundational = ranked.filter((match) => match.entry.foundationalWorldview)
  const ordinaryRanked = ranked.filter((match) => !match.entry.foundationalWorldview)
  const rankedIds = new Set(ranked.map((match) => match.entry.id))
  const fallback = opts.includeHighPriorityFallback
    ? entries
      .filter((entry) => !entry.foundationalWorldview && entry.keywords.length > 0 && !rankedIds.has(entry.id))
      .sort((a, b) => b.priority - a.priority || b.updatedAt - a.updatedAt)
      .map((entry) => ({ entry, score: entry.priority }))
    : []

  // Foundational worldview is a global hard premise and is never displaced by
  // ordinary retrieval limits. The management UI warns when users mark too
  // much content as foundational; silently omitting canon here would be worse.
  const selected: WorldbookMatch[] = [...foundational]
  let used = foundational.reduce((sum, match) => sum + renderEntry(match.entry, collections).length + 2, 0)
  for (const match of [...ordinaryRanked, ...fallback].slice(0, maxEntries)) {
    const blockLength = renderEntry(match.entry, collections).length + 2
    if (selected.length > foundational.length && used + blockLength > maxChars) continue
    if (selected.length === foundational.length && foundational.length > 0 && used + blockLength > maxChars) continue
    selected.push(match)
    used += blockLength
  }

  if (useSettingsStore.getState().adminModeEnabled && selected.length) {
    const signature = selected.map((match) => `${match.entry.id}:${match.score}`).join('|')
    const now = Date.now()
    if (signature !== lastLoggedMatchSignature || now - lastLoggedMatchAt > 30_000) {
      lastLoggedMatchSignature = signature
      lastLoggedMatchAt = now
      console.log('[worldbook] 命中:', selected.map((match) => `${match.entry.title}(${match.score})`).join('、'))
    }
  }

  const foundationalText = foundational.map((match) => renderEntry(match.entry, collections)).join('\n\n')
  const ordinaryText = selected.filter((match) => !match.entry.foundationalWorldview).map((match) => renderEntry(match.entry, collections)).join('\n\n')
  const text = [
    foundationalText ? `【底层世界观——全局最高优先级正史】\n以下规则默认约束所有主要内容生成，不得被现实常识、普通世界书或自由发挥覆盖。\n${foundationalText}` : '',
    ordinaryText,
  ].filter(Boolean).join('\n\n')
  return { text, matches: selected }
}

export async function retrieveWorldbookContext(query: string, opts: WorldbookRetrievalOptions = {}) {
  return (await retrieveWorldbookTrace(query, opts)).text
}

export async function selectedWorldbookEntriesText(ids: string[]) {
  if (!ids.length) return ''
  const [entries, collectionsList] = await Promise.all([db.worldbookEntries.bulkGet(ids), db.worldbookCollections.toArray()])
  const collections = new Map(collectionsList.map((collection) => [collection.id, collection]))
  return entries.filter((entry): entry is WorldbookEntry => !!entry).map((entry) => renderEntry(entry, collections)).join('\n\n')
}

export async function ensureLegacyWorldviewMigrated(): Promise<void> {
  const settings = useSettingsStore.getState()
  if (settings.worldbookMigrationCompleted) return
  const content = settings.worldview.trim()
  if (content) {
    const now = Date.now()
    await db.transaction('rw', db.worldbookCollections, db.worldbookEntries, async () => {
      await db.worldbookCollections.put({
        id: 'default-worldbook', name: '默认世界书', enabled: true, sourceType: 'manual', createdAt: now, updatedAt: now,
      })
      await db.worldbookEntries.put({
        id: 'legacy-worldview', collectionId: 'default-worldbook', title: '旧世界设定', content, keywords: [], enabled: true,
        foundationalWorldview: true, priority: 100, createdAt: now, updatedAt: now,
      })
    })
  }
  settings.setSettings({ worldview: '', worldbookMigrationCompleted: true })
}
