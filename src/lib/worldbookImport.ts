import { v4 as uuid } from 'uuid'
import type { WorldbookCollection, WorldbookEntry, WorldbookSourceType } from '../types'

type JsonObject = Record<string, unknown>

export interface ParsedWorldbookImport {
  collection: WorldbookCollection
  entries: WorldbookEntry[]
  warnings: string[]
}

function object(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
  if (typeof value === 'string') return [...new Set(value.split(/[,，、\n]+/).map((item) => item.trim()).filter(Boolean))]
  return []
}

function number(value: unknown, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function fileStem(name: string) {
  return name.replace(/\.[^.]+$/, '') || '导入的世界书'
}

function decodeBase64Utf8(value: string) {
  const binary = atob(value)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/** Reads SillyTavern's `ccv3`/`chara` tEXt chunk without executing card content. */
export function extractCharacterCardJsonFromPng(buffer: ArrayBuffer): unknown {
  const data = new Uint8Array(buffer)
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (!signature.every((byte, index) => data[index] === byte)) throw new Error('这不是有效的 PNG 文件')
  const chunks = new Map<string, string>()
  const view = new DataView(buffer)
  let offset = 8
  while (offset + 12 <= data.length) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(...data.slice(offset + 4, offset + 8))
    const start = offset + 8
    const end = start + length
    if (end + 4 > data.length) break
    if (type === 'tEXt') {
      const payload = data.slice(start, end)
      const separator = payload.indexOf(0)
      if (separator >= 0) {
        const keyword = new TextDecoder('latin1').decode(payload.slice(0, separator)).toLowerCase()
        const encoded = new TextDecoder('latin1').decode(payload.slice(separator + 1))
        if (keyword === 'ccv3' || keyword === 'chara') chunks.set(keyword, encoded)
      }
    }
    offset = end + 4
    if (type === 'IEND') break
  }
  const encoded = chunks.get('ccv3') ?? chunks.get('chara')
  if (!encoded) throw new Error('PNG 中没有找到 SillyTavern 角色卡数据')
  return JSON.parse(decodeBase64Utf8(encoded))
}

function recursivelyFindEntryArrays(value: unknown, path = 'root', depth = 0): Array<{ path: string; entries: unknown[] }> {
  if (depth > 5 || !value || typeof value !== 'object') return []
  const candidates: Array<{ path: string; entries: unknown[] }> = []
  if (Array.isArray(value)) {
    const matching = value.filter((item) => {
      const row = object(item)
      return !!row && ['content', 'entry', 'text'].some((key) => typeof row[key] === 'string')
    })
    if (matching.length && matching.length >= Math.ceil(value.length * 0.5)) candidates.push({ path, entries: value })
    return candidates
  }
  for (const [key, child] of Object.entries(value as JsonObject)) {
    candidates.push(...recursivelyFindEntryArrays(child, `${path}.${key}`, depth + 1))
  }
  return candidates
}

function findContainer(root: JsonObject): { entries: unknown[]; name?: string; sourceType: WorldbookSourceType; sourceLabel: string; warnings: string[] } {
  const data = object(root.data)
  const embedded = object(data?.character_book) ?? object(root.character_book)
  if (embedded && Array.isArray(embedded.entries)) {
    return { entries: embedded.entries, name: text(embedded.name) || text(data?.name) || text(root.name), sourceType: 'character-card', sourceLabel: 'SillyTavern 角色卡内嵌世界书', warnings: [] }
  }
  if (root.lorebookVersion !== undefined && Array.isArray(root.entries)) {
    return { entries: root.entries, name: text(root.name), sourceType: 'novelai', sourceLabel: 'NovelAI 世界书', warnings: [] }
  }
  if (root.kind === 'memory' && Array.isArray(root.entries)) {
    return { entries: root.entries, name: text(root.name), sourceType: 'agnai', sourceLabel: 'Agnai Memory Book', warnings: [] }
  }
  if (root.type === 'risu' && Array.isArray(root.data)) {
    return { entries: root.data, name: text(root.name), sourceType: 'risu', sourceLabel: 'Risu 世界书', warnings: [] }
  }
  if (Array.isArray(root.entries)) {
    return { entries: root.entries, name: text(root.name), sourceType: 'generic', sourceLabel: '世界书 JSON', warnings: [] }
  }
  const entriesObject = object(root.entries)
  if (entriesObject) {
    return { entries: Object.values(entriesObject), name: text(root.name), sourceType: 'sillytavern', sourceLabel: 'SillyTavern 世界书', warnings: [] }
  }
  const candidates = recursivelyFindEntryArrays(root).sort((a, b) => b.entries.length - a.entries.length)
  if (candidates.length) {
    const chosen = candidates[0]
    const warnings = [`文件结构不标准，已从 ${chosen.path} 识别出 ${chosen.entries.length} 个疑似条目。请在导入后检查内容。`]
    if (candidates.length > 1) warnings.push(`还发现 ${candidates.length - 1} 组较小的候选条目，当前选择了数量最多的一组。`)
    return { entries: chosen.entries, name: text(root.name), sourceType: 'generic', sourceLabel: '非标准世界书', warnings }
  }
  if (data && (text(data.name) || text(data.description) || text(data.personality))) {
    throw new Error('该角色卡没有内嵌世界书，请从创建人物页面导入角色卡')
  }
  throw new Error('没有找到可导入的世界书条目')
}

function normalizeEntry(value: unknown, collectionId: string, index: number, now: number): WorldbookEntry | null {
  const row = object(value)
  if (!row) return null
  const content = text(row.content) || text(row.entry) || text(row.text)
  if (!content) return null
  const keywords = stringList(row.keys).length ? stringList(row.keys)
    : stringList(row.key).length ? stringList(row.key)
      : stringList(row.keywords)
  const title = text(row.comment) || text(row.name) || text(row.displayName) || text(row.title) || keywords[0] || `未命名条目 ${index + 1}`
  const enabled = typeof row.enabled === 'boolean' ? row.enabled : typeof row.disable === 'boolean' ? !row.disable : true
  const priorityValue = row.priority ?? row.order ?? row.insertion_order ?? row.weight ?? object(row.contextConfig)?.budgetPriority
  return {
    id: uuid(),
    collectionId,
    title,
    content,
    keywords,
    enabled,
    foundationalWorldview: false,
    priority: Math.max(0, Math.min(100, number(priorityValue, 50))),
    sourceEntryId: String(row.id ?? row.uid ?? index),
    sourceOrder: index,
    rawData: row,
    createdAt: now,
    updatedAt: now,
  }
}

export async function parseWorldbookFile(file: File): Promise<ParsedWorldbookImport> {
  let parsed: unknown
  if (file.name.toLowerCase().endsWith('.png')) parsed = extractCharacterCardJsonFromPng(await file.arrayBuffer())
  else parsed = JSON.parse(await file.text())
  const root = object(parsed)
  if (!root) throw new Error('文件内容不是有效的 JSON 对象')
  const container = findContainer(root)
  const now = Date.now()
  const collectionId = uuid()
  const entries = container.entries.map((entry, index) => normalizeEntry(entry, collectionId, index, now)).filter((entry): entry is WorldbookEntry => !!entry)
  if (!entries.length) throw new Error('世界书中没有包含正文的有效条目')
  const scriptCount = entries.filter((entry) => /<%[=_-]?|\/setvar\b|\/setentryfield\b|<update>/i.test(entry.content)).length
  const warnings = [...container.warnings]
  if (scriptCount) warnings.push(`检测到 ${scriptCount} 个包含 SillyTavern 专用脚本或模板的条目。Talk 会保留原文，但绝不会执行这些代码。`)
  return {
    collection: {
      id: collectionId,
      name: container.name || fileStem(file.name),
      enabled: true,
      sourceType: container.sourceType,
      sourceFileName: file.name,
      sourceLabel: container.sourceLabel,
      createdAt: now,
      updatedAt: now,
    },
    entries,
    warnings,
  }
}
