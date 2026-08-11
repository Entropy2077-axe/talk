import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { useSettingsStore } from '../store/useSettingsStore'
import { estimateWorldbookTokens, formatEstimatedTokens } from '../lib/worldbookTokens'
import { materializeLibraryItem } from '../lib/worldviewImport'
import { searchLibraryItems } from '../lib/library'
import { deleteWorld as deleteWorldData, getWorldDeletionImpact, normalizeWorldSnapshotData } from '../lib/worldSnapshots'
import type { WorldbookEntry } from '../types'

const EMPTY_ENTRIES: WorldbookEntry[] = []
const EMPTY_LIBRARY_ITEMS: never[] = []

export function WorldbookCollectionPage() {
  const { collectionId: legacyCollectionId = '', worldId = '' } = useParams()
  const collectionId = worldId || legacyCollectionId
  const navigate = useNavigate()
  const location = useLocation()
  const returnToWorldPicker = (location.state as { returnTo?: string } | null)?.returnTo === '/save-load'
  const goBack = () => returnToWorldPicker ? navigate(-1) : navigate(`/library?view=worldview&worldId=${collectionId}`, { replace: true })
  const settings = useSettingsStore()
  const collection = useLiveQuery(() => db.worldbookCollections.get(collectionId), [collectionId])
  const entries = useLiveQuery(() => db.worldbookEntries.where('collectionId').equals(collectionId).sortBy('sourceOrder'), [collectionId]) ?? EMPTY_ENTRIES
  const libraryItems = useLiveQuery(() => db.libraryItems.toArray(), []) ?? EMPTY_LIBRARY_ITEMS
  const snapshots = useLiveQuery(() => db.worldSnapshots.where('worldId').equals(collectionId).toArray(), [collectionId]) ?? []
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<WorldbookEntry | null>(null)
  const [keywords, setKeywords] = useState('')
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [libraryQuery, setLibraryQuery] = useState('')
  const [selectedLibraryIds, setSelectedLibraryIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const visible = useMemo(() => entries.filter((entry) => {
    const needle = query.trim().toLocaleLowerCase()
    return !needle || entry.title.toLocaleLowerCase().includes(needle) || entry.content.toLocaleLowerCase().includes(needle) || entry.keywords.some((keyword) => keyword.toLocaleLowerCase().includes(needle))
  }), [entries, query])
  const libraryVisible = useMemo(() => searchLibraryItems(libraryItems, libraryQuery), [libraryItems, libraryQuery])
  const permanent = entries.filter((entry) => entry.enabled && entry.keywords.length === 0)
  const triggered = entries.filter((entry) => entry.enabled && entry.keywords.length > 0)
  const latestSnapshot = [...snapshots].sort((a, b) => b.updatedAt - a.updatedAt)[0]
  const latestData = latestSnapshot ? normalizeWorldSnapshotData(latestSnapshot.snapshot) : undefined
  const storyContacts = latestData?.contactIds?.length ?? 0
  const storyGroups = latestData?.tables.groups?.length ?? 0

  function open(entry?: WorldbookEntry) {
    const now = Date.now()
    const next = entry ?? { id: uuid(), collectionId, title: '', content: '', keywords: [], enabled: true, foundationalWorldview: false, priority: 50, sourceOrder: entries.length, createdAt: now, updatedAt: now }
    setEditing({ ...next }); setKeywords(next.keywords.join('、')); setMessage('')
  }

  async function save() {
    if (!editing?.title.trim() || !editing.content.trim()) return setMessage('标题和正文不能为空')
    await db.worldbookEntries.put({ ...editing, title: editing.title.trim(), content: editing.content.trim(), keywords: [...new Set(keywords.split(/[、,，\n]+/).map((value) => value.trim()).filter(Boolean))], updatedAt: Date.now() })
    await db.worldbookCollections.update(collectionId, { updatedAt: Date.now() }); setEditing(null)
  }

  async function importSelected() {
    if (!selectedLibraryIds.length) return
    setBusy(true); setMessage('')
    try {
      const selected = libraryItems.filter((item) => selectedLibraryIds.includes(item.id))
      const results = []
      for (const item of selected) results.push(await materializeLibraryItem(item, collectionId, settings))
      await db.worldbookEntries.bulkAdd(results.map((result, index) => ({ ...result.entry, sourceOrder: entries.length + index })))
      await db.libraryItems.bulkUpdate(selected.map((item) => ({ key: item.id, changes: { lastUsedAt: Date.now() } })))
      await db.worldbookCollections.update(collectionId, { updatedAt: Date.now() })
      const compressed = results.filter((result) => result.compressed).length
      setMessage(`已加入 ${results.length} 条资料${compressed ? `，其中 ${compressed} 条经过AI压缩` : '，全部保留原文'}`)
      setSelectedLibraryIds([]); setLibraryOpen(false)
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  async function deleteWorld() {
    if (!collection) return
    if ((settings.activeWorldId || settings.defaultWorldviewId) === collectionId) return setMessage('当前世界不能删除，请先在“选择世界”中切换。')
    const impact = await getWorldDeletionImpact(collectionId)
    const summary = `${impact.worldbookEntries} 个世界观条目、${impact.backups} 个备份、${impact.conversations} 个会话、${impact.messages} 条消息、${impact.moments} 条朋友圈、${impact.groups} 个群聊、${impact.experiences} 条经历`
    if (!window.confirm(`删除“${collection.name}”吗？\n\n将删除：${summary}。\n\n全局联系人不会删除。`)) return
    if (!window.confirm(`请再次确认：永久删除“${collection.name}”的世界观、全部备份与剧情状态？`)) return
    await deleteWorldData(collectionId)
    if (settings.defaultWorldviewId === collectionId) settings.setSettings({ defaultWorldviewId: undefined })
    void navigate('/library?view=worldview', { replace: true })
  }

  if (!collection) return <div className="flex h-[var(--app-height)] flex-col bg-[#f4f4f6]"><TopBar title="世界观" showBack onBack={goBack}/><div className="flex flex-1 items-center justify-center text-sm text-gray-400">加载中或世界不存在</div></div>
  return <div className="relative flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
      <TopBar title={collection.name} showBack onBack={goBack}/>
    <div className="flex-1 overflow-y-auto px-4 pb-8">
      <section className="mt-3 rounded-xl bg-white p-4"><div className="flex justify-between gap-3"><div><p className="font-medium text-gray-900">{entries.length} 个正史条目</p><p className="mt-1 text-xs text-gray-400">最新剧情含 {storyContacts} 个联系人状态 · {storyGroups} 个群聊</p></div><button type="button" onClick={async () => { const name = window.prompt('世界观名称', collection.name)?.trim(); if (name) await db.worldbookCollections.update(collection.id, { name, updatedAt: Date.now() }) }} className="text-xs text-blue-600">重命名</button></div><div className="mt-3 grid grid-cols-3 gap-2 text-center text-[10px]"><div className="rounded-lg bg-gray-50 p-2 text-gray-600">总内容<br/><b>{formatEstimatedTokens(estimateWorldbookTokens(entries))}</b></div><div className="rounded-lg bg-amber-50 p-2 text-amber-700">每轮常驻<br/><b>{formatEstimatedTokens(estimateWorldbookTokens(permanent))}</b></div><div className="rounded-lg bg-blue-50 p-2 text-blue-600">按需触发<br/><b>{formatEstimatedTokens(estimateWorldbookTokens(triggered))}</b></div></div>{estimateWorldbookTokens(permanent) > 4000 && <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">常驻内容超过4000 Token，可能明显挤占聊天记录和人物记忆。</p>}</section>

      <section className="mt-3 grid grid-cols-2 gap-2 rounded-xl bg-white p-3"><button type="button" onClick={() => open()} className="rounded-lg bg-gray-900 py-2.5 text-sm text-white">手写条目</button><button type="button" onClick={() => setLibraryOpen(true)} className="rounded-lg bg-gray-100 py-2.5 text-sm text-gray-700">从资料库加入</button></section>
      {message && <p className="mt-3 rounded-lg bg-white px-3 py-2 text-xs leading-relaxed text-gray-500">{message}</p>}
      <div className="sticky top-0 z-10 -mx-4 mt-3 bg-[#f4f4f6] px-4 py-2"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索正史标题、关键词或正文" className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm"/></div>
      <div className="space-y-2">{visible.map((entry) => <article key={entry.id} className="rounded-xl bg-white p-4"><div className="flex items-start gap-3"><button type="button" onClick={() => void db.worldbookEntries.update(entry.id, { enabled: !entry.enabled, updatedAt: Date.now() })} className={`mt-0.5 h-5 w-5 shrink-0 rounded border text-xs ${entry.enabled ? 'border-green-500 bg-green-500 text-white' : 'border-gray-300 text-transparent'}`}>✓</button><button type="button" onClick={() => open(entry)} className="min-w-0 flex-1 text-left"><p className="font-medium text-gray-900">{entry.title}</p><p className="mt-1 line-clamp-3 text-sm leading-relaxed text-gray-500">{entry.content}</p><div className="mt-2 flex flex-wrap gap-1 text-[10px]"><span className={`rounded-full px-2 py-1 ${entry.keywords.length ? 'bg-blue-50 text-blue-600' : 'bg-amber-50 text-amber-700'}`}>{entry.keywords.length ? `关键词 ${entry.keywords.length}` : '每轮常驻'}</span><span className="rounded-full bg-gray-100 px-2 py-1 text-gray-500">{formatEstimatedTokens(estimateWorldbookTokens([entry]))}</span></div></button><span className="text-gray-300">›</span></div></article>)}{!visible.length && <p className="py-10 text-center text-sm text-gray-400">暂无条目</p>}</div>
      <button type="button" onClick={() => void deleteWorld()} className="mt-6 w-full rounded-lg bg-red-50 py-2.5 text-sm text-red-600">删除这个世界</button>
    </div>

    {editing && <div className="absolute inset-0 z-30 flex items-center bg-black/30 p-5"><div className="max-h-[92%] w-full overflow-y-auto rounded-2xl bg-white p-4"><h2 className="font-medium">编辑正史条目</h2><input value={editing.title} onChange={(event) => setEditing({ ...editing, title: event.target.value })} placeholder="标题" className="mt-3 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"/><textarea value={editing.content} onChange={(event) => setEditing({ ...editing, content: event.target.value })} rows={11} placeholder="正文" className="mt-2 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"/><input value={keywords} onChange={(event) => setKeywords(event.target.value)} placeholder="关键词，用逗号、顿号或换行分隔" className="mt-2 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"/><p className="mt-1 text-[11px] text-gray-400">留空表示每轮常驻；填写后按当前聊天内容匹配。</p>{Array.isArray(editing.rawData?.suggestedKeywords) && editing.rawData.suggestedKeywords.length > 0 && <button type="button" onClick={() => setKeywords([...new Set([...keywords.split(/[、,，\n]+/).filter(Boolean), ...(editing.rawData?.suggestedKeywords as string[])])].join('、'))} className="mt-2 rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-600">采用AI建议：{(editing.rawData.suggestedKeywords as string[]).join('、')}</button>}<div className="mt-4 flex gap-2"><button type="button" onClick={() => setEditing(null)} className="flex-1 rounded-lg bg-gray-100 py-2.5 text-sm">取消</button>{entries.some((entry) => entry.id === editing.id) && <button type="button" onClick={() => { if (window.confirm('删除这个条目吗？')) { void db.worldbookEntries.delete(editing.id); setEditing(null) } }} className="rounded-lg bg-red-50 px-4 text-sm text-red-600">删除</button>}<button type="button" onClick={() => void save()} className="flex-1 rounded-lg bg-gray-900 py-2.5 text-sm text-white">保存</button></div></div></div>}

    {libraryOpen && <div className="absolute inset-0 z-30 flex flex-col bg-[#f4f4f6]"><TopBar title="从资料库加入" showBack onBack={() => setLibraryOpen(false)}/><div className="flex-1 overflow-y-auto px-4 pb-24"><div className="sticky top-0 z-10 -mx-4 bg-[#f4f4f6] px-4 py-3"><input value={libraryQuery} onChange={(event) => setLibraryQuery(event.target.value)} placeholder="按匹配度搜索资料" className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm"/><p className="mt-2 text-xs text-gray-400">已选 {selectedLibraryIds.length} 条。原关键词会继承；无关键词资料保持常驻。</p></div><div className="space-y-2">{libraryVisible.map((item) => { const checked = selectedLibraryIds.includes(item.id); return <button type="button" key={item.id} onClick={() => setSelectedLibraryIds((current) => checked ? current.filter((id) => id !== item.id) : [...current, item.id])} className="flex w-full items-start gap-3 rounded-xl bg-white p-4 text-left"><span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border text-xs ${checked ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-300'}`}>{checked && '✓'}</span><span className="min-w-0 flex-1"><span className="block font-medium text-gray-900">{item.title}</span><span className="mt-1 line-clamp-3 block text-xs leading-relaxed text-gray-500">{item.content}</span><span className="mt-2 block text-[10px] text-gray-400">{item.keywords.length ? `继承关键词：${item.keywords.slice(0, 5).join('、')}` : '无关键词 · 加入后保持常驻'}{'matchPercent' in item && libraryQuery.trim() ? ` · ${item.matchPercent}%匹配` : ''}</span></span></button> })}</div></div><div className="absolute inset-x-0 bottom-0 border-t border-gray-100 bg-white p-3"><button type="button" disabled={busy || !selectedLibraryIds.length} onClick={() => void importSelected()} className="w-full rounded-lg bg-gray-900 py-2.5 text-sm text-white disabled:opacity-40">{busy ? '正在整理资料…' : `加入世界观（${selectedLibraryIds.length}）`}</button></div></div>}
  </div>
}
