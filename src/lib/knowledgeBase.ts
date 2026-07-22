import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { chatCompletion } from './deepseek'
import { tavilySearch, type WebSearchResult } from './webSearch'
import { useSettingsStore } from '../store/useSettingsStore'
import { toDateKey } from './time'
import type { AppSettings, KnowledgeEntry } from '../types'
import { getPromptTemplate, promptModuleEnabled } from './promptModules'

/** Entries older than this are pruned whenever new ones are added, so the table (and the prompt digest) don't grow forever. */
const MAX_ENTRY_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** How many of the most recent entries get injected into chat prompts. */
const DIGEST_ENTRY_COUNT = 15

/** Hard ceiling on reactive keyword-triggered searches per day — the cost backstop, since this now fires directly out of ordinary chat turns rather than a slow periodic timer. */
const DAILY_QUERY_CAP = 8

function buildKnowledgeSummaryPrompt(rawResultsPerQuery: { query: string; results: WebSearchResult[] }[], settings: AppSettings): string {
  const sections = rawResultsPerQuery
    .map((q) => {
      const lines = q.results.map((r, i) => `  ${i + 1}. ${r.title}: ${r.content}`).join('\n')
      return `搜索方向: ${q.query}\n${lines || '  (没有搜到相关内容)'}`
    })
    .join('\n\n')

  const editable = getPromptTemplate(settings, 'knowledgeBase', 'summary', { searchResults: sections }) ?? ''
  return `${editable}\n\n固定输出协议：只输出JSON {"entries":[{"sourceQuery":"原搜索方向","topic":"简短主题","content":"50到100字具体内容"}]}`
}

interface ParsedKnowledgeEntry {
  sourceQuery: string
  topic: string
  content: string
}

function parseKnowledgeEntries(raw: string): ParsedKnowledgeEntry[] | null {
  let text = raw.trim()
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch) text = fenceMatch[1].trim()
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed?.entries)) return null
    const result: ParsedKnowledgeEntry[] = []
    for (const e of parsed.entries) {
      if (!e || typeof e.topic !== 'string' || !e.topic.trim()) continue
      if (typeof e.content !== 'string' || !e.content.trim()) continue
      const sourceQuery = typeof e.sourceQuery === 'string' ? e.sourceQuery.trim() : ''
      result.push({ sourceQuery, topic: e.topic.trim(), content: e.content.trim() })
    }
    return result
  } catch {
    return null
  }
}

/**
 * The model is asked to echo back which "搜索方向" each entry came from, but
 * isn't 100% reliable about copying it verbatim — if what it wrote doesn't
 * match any of the queries actually searched, fall back to the single query
 * for that batch (the common case: one new keyword per turn) rather than
 * leaving sourceQuery empty, which would silently break dedup for that entry.
 */
function resolveSourceQuery(claimed: string, queries: string[]): string {
  const norm = normalizeTopic(claimed)
  const match = queries.find((q) => normalizeTopic(q) === norm)
  if (match) return match
  return queries.length === 1 ? queries[0] : claimed
}

async function pruneOldKnowledgeEntries(now: number): Promise<void> {
  await db.knowledgeEntries.where('fetchedAt').below(now - MAX_ENTRY_AGE_MS).delete()
}

function normalizeTopic(s: string): string {
  return s.trim().toLowerCase()
}

/** Loose containment match, not exact — "三角洲行动" and "三角洲行动 平衡性" should count as the same topic already covered. Compares against `sourceQuery` (the original search keyword), NOT `topic` (an LLM-invented sub-headline per fact, unrelated to the query text — comparing against that never matched anything real). */
function hasKnowledgeForQuery(query: string, entries: KnowledgeEntry[]): boolean {
  const norm = normalizeTopic(query)
  if (!norm) return true
  return entries.some((e) => {
    const t = normalizeTopic(e.sourceQuery)
    return t.includes(norm) || norm.includes(t)
  })
}

function canQueryKnowledgeToday(): boolean {
  const { knowledgeQueryLog } = useSettingsStore.getState()
  const today = toDateKey(new Date())
  if (!knowledgeQueryLog || knowledgeQueryLog.date !== today) return true
  return knowledgeQueryLog.count < DAILY_QUERY_CAP
}

function recordKnowledgeQueriesSent(n: number): void {
  const { knowledgeQueryLog, setSettings } = useSettingsStore.getState()
  const today = toDateKey(new Date())
  const count = knowledgeQueryLog && knowledgeQueryLog.date === today ? knowledgeQueryLog.count + n : n
  setSettings({ knowledgeQueryLog: { date: today, count } })
}

async function searchAndStore(topics: { query: string }[], settings: AppSettings): Promise<ParsedKnowledgeEntry[]> {
  if (!promptModuleEnabled(settings, 'knowledgeBase')) return []
  const rawResultsPerQuery: { query: string; results: WebSearchResult[] }[] = []
  for (const { query } of topics) {
    try {
      const results = await tavilySearch(settings.tavilyApiKey, query)
      rawResultsPerQuery.push({ query, results })
    } catch {
      // one topic failing shouldn't sink the rest
    }
  }
  const totalResults = rawResultsPerQuery.reduce((sum, q) => sum + q.results.length, 0)
  if (totalResults === 0) return []

  const raw = await chatCompletion({
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    model: settings.model,
    purpose: 'other',
    messages: [
      { role: 'system', content: buildKnowledgeSummaryPrompt(rawResultsPerQuery, settings) },
      { role: 'user', content: '请生成' },
    ],
    jsonMode: true,
  })
  const entries = parseKnowledgeEntries(raw) ?? []
  const queries = topics.map((t) => t.query)
  return entries.map((e) => ({ ...e, sourceQuery: resolveSourceQuery(e.sourceQuery, queries) }))
}

/**
 * Reactive, one-shot knowledge gathering: called whenever a chat turn (1:1
 * or group) flags `knowledgeQueries` in its JSON response — see
 * aiProtocol.ts/groupChat.ts. Per the user's spec this is deliberately NOT
 * iterative — once a topic is covered (even loosely, see
 * hasKnowledgeForQuery), it's never re-searched, unlike the old fixed
 * 3-query/15-day periodic refresh this replaced entirely.
 */
export async function processKnowledgeQueries(queries: string[], settings: AppSettings): Promise<void> {
  await resolveKnowledgeQueries(queries, settings)
}

export interface KnowledgeResolution { text: string; keywords: string[]; searched: boolean }
/** Resolve query keywords from cache first, search missing ones, persist them, and return model-ready evidence. */
export async function resolveKnowledgeQueries(queries: string[], settings: AppSettings): Promise<KnowledgeResolution> {
  try {
    if (queries.length === 0) return { text: '', keywords: [], searched: false }

    const existing = await db.knowledgeEntries.toArray()
    const seen = new Set<string>()
    const newTopics: string[] = []
    for (const q of queries) {
      const norm = normalizeTopic(q)
      if (!norm || seen.has(norm)) continue
      seen.add(norm)
      if (hasKnowledgeForQuery(q, existing)) continue
      newTopics.push(q)
    }
    let searched = false
    if (newTopics.length > 0 && settings.tavilyApiKey && settings.apiKey && canQueryKnowledgeToday()) {
      const entries = await searchAndStore(newTopics.map((q) => ({ query: q })), settings)
      if (entries.length > 0) {
        const now = Date.now()
        for (const e of entries) await db.knowledgeEntries.add({ id: uuid(), sourceQuery: e.sourceQuery, topic: e.topic, content: e.content, fetchedAt: now })
        await pruneOldKnowledgeEntries(now)
        recordKnowledgeQueriesSent(newTopics.length)
        searched = true
      }
    }

    const all = await db.knowledgeEntries.toArray()
    const matched = all.filter(e => queries.some(q => hasKnowledgeForQuery(q, [e])))
    const text = matched.slice(-6).map(e => `关键词「${e.sourceQuery}」\n${e.topic}: ${e.content}`).join('\n\n')
    return { text, keywords: queries, searched }
  } catch {
    return { text: '', keywords: queries, searched: false }
  }
}

export interface SearchKnowledgeTopicResult {
  addedCount: number
  message?: string
}

/**
 * Manual, user-directed search (the search box in WorldSettingsPage) — an
 * explicit user action, so unlike processKnowledgeQueries it does NOT dedup
 * against existing entries (the user might deliberately want a fresher take
 * on something already covered) and doesn't count against the daily cap.
 */
export async function searchKnowledgeTopic(topic: string, settings: AppSettings): Promise<SearchKnowledgeTopicResult> {
  if (!settings.tavilyApiKey) return { addedCount: 0, message: '还没有配置Tavily API Key' }
  if (!settings.apiKey) return { addedCount: 0, message: '还没有配置DeepSeek API Key' }
  const trimmed = topic.trim()
  if (!trimmed) return { addedCount: 0, message: '请输入要搜索的内容' }

  const entries = await searchAndStore([{ query: trimmed }], settings)
  if (entries.length === 0) return { addedCount: 0, message: '搜索或整理失败 请再试一次' }

  const now = Date.now()
  for (const e of entries) {
    await db.knowledgeEntries.add({ id: uuid(), sourceQuery: e.sourceQuery, topic: e.topic, content: e.content, fetchedAt: now })
  }
  await pruneOldKnowledgeEntries(now)
  return { addedCount: entries.length }
}

/** Model-facing digest of the most recent entries, dated, for prompt injection — empty string if the knowledge base is empty. */
export function knowledgeDigestText(entries: KnowledgeEntry[]): string {
  if (entries.length === 0) return ''
  const sorted = [...entries].sort((a, b) => b.fetchedAt - a.fetchedAt).slice(0, DIGEST_ENTRY_COUNT)
  return sorted.map((e) => `- [${toDateKey(new Date(e.fetchedAt))}] ${e.topic}: ${e.content}`).join('\n')
}
