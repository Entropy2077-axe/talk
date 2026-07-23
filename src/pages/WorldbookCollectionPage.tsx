import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate, useParams } from 'react-router-dom'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { useSettingsStore } from '../store/useSettingsStore'
import { chatCompletion } from '../lib/deepseek'
import { buildWorldviewDraftPrompt, parseWorldviewDraft } from '../lib/prompt'
import { promptModuleEnabled } from '../lib/promptModules'
import type { WorldbookEntry } from '../types'
import { estimateWorldbookTokens, formatEstimatedTokens } from '../lib/worldbookTokens'

type Filter = 'all' | 'enabled' | 'disabled' | 'foundational'
const EMPTY_ENTRIES: WorldbookEntry[] = []

export function WorldbookCollectionPage() {
  const { collectionId = '' } = useParams()
  const navigate = useNavigate()
  const settings = useSettingsStore()
  const collection = useLiveQuery(() => db.worldbookCollections.get(collectionId), [collectionId])
  const entries = useLiveQuery(() => db.worldbookEntries.where('collectionId').equals(collectionId).sortBy('sourceOrder'), [collectionId]) ?? EMPTY_ENTRIES
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [editing, setEditing] = useState<WorldbookEntry | null>(null)
  const [keywords, setKeywords] = useState('')
  const [idea, setIdea] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const visible = useMemo(() => entries.filter((entry) => {
    if (filter === 'enabled' && !entry.enabled) return false
    if (filter === 'disabled' && entry.enabled) return false
    if (filter === 'foundational' && !entry.foundationalWorldview) return false
    const needle = query.trim().toLowerCase()
    return !needle || entry.title.toLowerCase().includes(needle) || entry.content.toLowerCase().includes(needle) || entry.keywords.some((keyword) => keyword.toLowerCase().includes(needle))
  }).sort((a, b) => {
    const needle = query.trim().toLowerCase()
    if (!needle) return (a.sourceOrder ?? 0) - (b.sourceOrder ?? 0)
    const score = (entry: WorldbookEntry) => entry.title.toLowerCase() === needle ? 1000
      : entry.title.toLowerCase().includes(needle) ? 500
        : entry.keywords.some((keyword) => keyword.toLowerCase() === needle) ? 300
          : entry.keywords.some((keyword) => keyword.toLowerCase().includes(needle)) ? 200 : 0
    return score(b) - score(a) || (a.sourceOrder ?? 0) - (b.sourceOrder ?? 0)
  }), [entries, filter, query])

  const foundational = entries.filter((entry) => entry.enabled && entry.foundationalWorldview)
  const enabledEntries = entries.filter((entry) => entry.enabled)
  const totalTokens = estimateWorldbookTokens(entries)
  const enabledTokens = estimateWorldbookTokens(enabledEntries)
  const foundationalTokens = estimateWorldbookTokens(foundational)

  function open(entry?: WorldbookEntry) {
    const now = Date.now()
    const next = entry ?? { id: uuid(), collectionId, title: '', content: '', keywords: [], enabled: true, foundationalWorldview: false, priority: 50, sourceOrder: entries.length, createdAt: now, updatedAt: now }
    setEditing({ ...next })
    setKeywords(next.keywords.join('、'))
    setError('')
  }

  async function save() {
    if (!editing?.title.trim() || !editing.content.trim()) return setError('标题和正文不能为空')
    await db.worldbookEntries.put({ ...editing, title: editing.title.trim(), content: editing.content.trim(), keywords: keywords.split(/[、,，\n]+/).map((value) => value.trim()).filter(Boolean), priority: Math.max(0, Math.min(100, editing.priority)), updatedAt: Date.now() })
    await db.worldbookCollections.update(collectionId, { updatedAt: Date.now() })
    setEditing(null)
  }

  async function generate() {
    if (!idea.trim() || !settings.apiKey) return setError(settings.apiKey ? '请输入世界设定想法' : '请先在设置中配置 API Key')
    setBusy(true); setError('')
    try {
      if (!promptModuleEnabled(settings, 'worldview')) throw new Error('世界书提示词模块已屏蔽')
      const raw = await chatCompletion({ apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.utilityModel, messages: [{ role: 'system', content: buildWorldviewDraftPrompt(idea.trim(), '', settings.promptModules) }, { role: 'user', content: '请生成' }], jsonMode: true, purpose: 'worldbook' })
      const parsed = parseWorldviewDraft(raw)
      if (!parsed) throw new Error('生成结果解析失败')
      const now = Date.now()
      open({ id: uuid(), collectionId, title: idea.trim().slice(0, 24), content: parsed.worldview, keywords: [], enabled: true, foundationalWorldview: false, priority: 50, sourceOrder: entries.length, createdAt: now, updatedAt: now })
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  async function bulkEnable(enabled: boolean) {
    await db.worldbookEntries.bulkUpdate(visible.map((entry) => ({ key: entry.id, changes: { enabled, updatedAt: Date.now() } })))
  }

  async function deleteCollection() {
    if (!collection || !window.confirm(`确定删除“${collection.name}”及其 ${entries.length} 个条目吗？`)) return
    await db.transaction('rw', db.worldbookCollections, db.worldbookEntries, async () => {
      await db.worldbookEntries.where('collectionId').equals(collectionId).delete()
      await db.worldbookCollections.delete(collectionId)
    })
    navigate('/world-settings')
  }

  async function renameCollection() {
    if (!collection) return
    const name = window.prompt('集合名称', collection.name)?.trim()
    if (name) await db.worldbookCollections.update(collection.id, { name, updatedAt: Date.now() })
  }

  if (collection === undefined) return <div className="flex h-[var(--app-height)] flex-col bg-[#f4f4f6]"><TopBar title="世界书集合" showBack onBack={() => navigate('/world-settings')}/><div className="flex flex-1 items-center justify-center text-sm text-gray-400">加载中…</div></div>
  if (!collection) return <div className="flex h-[var(--app-height)] flex-col bg-[#f4f4f6]"><TopBar title="世界书集合" showBack onBack={() => navigate('/world-settings')}/><div className="flex flex-1 items-center justify-center text-sm text-gray-400">集合不存在</div></div>

  return <div className="relative flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
    <TopBar title={collection.name} showBack onBack={() => navigate('/world-settings')} />
    <div className="flex-1 overflow-y-auto px-4 pb-8">
      <section className="mt-3 rounded-xl bg-white p-4">
        <div className="flex items-start justify-between gap-3"><div><p className="text-sm font-medium text-gray-900">{entries.length} 个条目 · 已启用 {entries.filter((entry) => entry.enabled).length} 个</p><p className="mt-1 text-xs text-gray-400">有关键词按内容匹配；没有关键词则常驻。底层世界观会进入所有主要内容生成。</p></div><button type="button" onClick={() => void renameCollection()} className="shrink-0 text-xs text-blue-600">重命名</button></div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg bg-gray-50 px-2 py-2"><p className="text-[10px] text-gray-400">全部</p><p className="mt-0.5 text-xs font-medium text-gray-700">{formatEstimatedTokens(totalTokens)}</p></div>
          <div className="rounded-lg bg-green-50 px-2 py-2"><p className="text-[10px] text-green-600">已启用</p><p className="mt-0.5 text-xs font-medium text-green-700">{formatEstimatedTokens(enabledTokens)}</p></div>
          <div className="rounded-lg bg-purple-50 px-2 py-2"><p className="text-[10px] text-purple-600">底层世界观</p><p className="mt-0.5 text-xs font-medium text-purple-700">{formatEstimatedTokens(foundationalTokens)}</p></div>
        </div>
        <div className="mt-3 flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2"><span className="text-sm text-gray-700">集合启用</span><button type="button" role="switch" aria-checked={collection.enabled} onClick={() => void db.worldbookCollections.update(collection.id, { enabled: !collection.enabled, updatedAt: Date.now() })} className={`relative h-6 w-11 rounded-full ${collection.enabled ? 'bg-green-500' : 'bg-gray-200'}`}><span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition ${collection.enabled ? 'left-5.5' : 'left-0.5'}`}/></button></div>
        {foundational.length > 0 && <p className={`mt-2 rounded-lg px-3 py-2 text-xs leading-relaxed ${foundationalTokens > 4000 ? 'bg-amber-50 text-amber-700' : 'bg-purple-50 text-purple-700'}`}>底层世界观 {foundational.length} 条，{formatEstimatedTokens(foundationalTokens)}。{foundationalTokens > 4000 ? '内容较长，可能明显占用模型上下文。' : '会作为全局最高优先级正史发送。'}</p>}
      </section>

      <section className="mt-3 rounded-xl bg-white p-3">
        <div className="grid grid-cols-2 gap-2"><button type="button" onClick={() => open()} className="rounded-lg bg-gray-900 py-2 text-sm text-white">新增条目</button><button type="button" onClick={() => void generate()} disabled={busy} className="rounded-lg bg-gray-100 py-2 text-sm text-gray-700 disabled:opacity-50">{busy ? '生成中…' : 'AI 帮写'}</button></div>
        <input value={idea} onChange={(event) => setIdea(event.target.value)} placeholder="AI 帮写的世界设定想法" className="mt-2 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"/>
        {error && !editing && <p className="mt-2 text-xs text-red-500">{error}</p>}
      </section>

      <div className="sticky top-0 z-10 -mx-4 mt-3 bg-[#f4f4f6] px-4 py-2">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、关键词或正文" className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm"/>
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1">{([['all','全部'],['enabled','已启用'],['disabled','已停用'],['foundational','底层世界观']] as const).map(([value,label]) => <button key={value} type="button" onClick={() => setFilter(value)} className={`shrink-0 rounded-full px-3 py-1.5 text-xs ${filter === value ? 'bg-gray-900 text-white' : 'bg-white text-gray-500'}`}>{label}</button>)}</div>
        <div className="mt-2 flex justify-end gap-3 text-xs"><button type="button" onClick={() => void bulkEnable(true)} className="text-green-600">启用当前结果</button><button type="button" onClick={() => void bulkEnable(false)} className="text-gray-500">停用当前结果</button></div>
      </div>

      <div className="space-y-2">{visible.map((entry) => <article key={entry.id} className="rounded-xl bg-white p-4">
        <div className="flex items-start gap-3"><button type="button" onClick={() => void db.worldbookEntries.update(entry.id, { enabled: !entry.enabled, updatedAt: Date.now() })} className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border text-xs ${entry.enabled ? 'border-green-500 bg-green-500 text-white' : 'border-gray-300 bg-white text-transparent'}`}>✓</button><button type="button" onClick={() => open(entry)} className="min-w-0 flex-1 text-left"><p className="font-medium text-gray-900">{entry.title}</p><p className="mt-1 line-clamp-3 text-sm leading-relaxed text-gray-500">{entry.content}</p><div className="mt-2 flex flex-wrap gap-1.5 text-[10px]"><span className="rounded-full bg-gray-100 px-2 py-1 text-gray-500">{formatEstimatedTokens(estimateWorldbookTokens([entry]))}</span><span className={`rounded-full px-2 py-1 ${entry.keywords.length ? 'bg-blue-50 text-blue-600' : 'bg-amber-50 text-amber-700'}`}>{entry.keywords.length ? `关键词 ${entry.keywords.length}` : '常驻'}</span>{entry.foundationalWorldview && <span className="rounded-full bg-purple-50 px-2 py-1 text-purple-700">底层世界观</span>}{/<%[=_-]?|\/setvar\b|<update>/i.test(entry.content) && <span className="rounded-full bg-gray-100 px-2 py-1 text-gray-500">含 ST 专用语法</span>}</div></button><span className="text-gray-300">›</span></div>
      </article>)}{visible.length === 0 && <p className="py-10 text-center text-sm text-gray-400">没有符合条件的条目</p>}</div>

      <button type="button" onClick={() => void deleteCollection()} className="mt-6 w-full rounded-lg bg-red-50 py-2.5 text-sm text-red-600">删除整个集合</button>
    </div>

    {editing && <div className="absolute inset-0 z-30 flex items-center bg-black/30 p-5"><div className="max-h-[92%] w-full overflow-y-auto rounded-2xl bg-white p-4">
      <h2 className="font-medium text-gray-900">编辑世界书条目</h2>
      <input value={editing.title} onChange={(event) => setEditing({ ...editing, title: event.target.value })} placeholder="标题" className="mt-3 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"/>
      <textarea value={editing.content} onChange={(event) => setEditing({ ...editing, content: event.target.value })} rows={10} placeholder="正文" className="mt-2 w-full resize-y rounded-lg border border-gray-200 px-3 py-2 text-sm leading-relaxed"/>
      <input value={keywords} onChange={(event) => setKeywords(event.target.value)} placeholder="关键词，用逗号、顿号或换行分隔" className="mt-2 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"/>
      <p className="mt-1 text-[11px] text-gray-400">留空即常驻；填写关键词后按对话内容匹配。</p>
      <label className="mt-3 block text-xs text-gray-500">优先级 {editing.priority}</label><input type="range" min="0" max="100" value={editing.priority} onChange={(event) => setEditing({ ...editing, priority: Number(event.target.value) })} className="w-full"/>
      <label className="mt-3 flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2 text-sm"><span>条目启用</span><input type="checkbox" checked={editing.enabled} onChange={(event) => setEditing({ ...editing, enabled: event.target.checked })}/></label>
      <label className="mt-2 flex items-start gap-3 rounded-lg bg-purple-50 px-3 py-3"><input type="checkbox" checked={editing.foundationalWorldview === true} onChange={(event) => setEditing({ ...editing, foundationalWorldview: event.target.checked })}/><span><span className="block text-sm font-medium text-purple-900">底层世界观</span><span className="mt-0.5 block text-[11px] leading-relaxed text-purple-600">启用后默认传给所有主要内容生成，并作为全局最高优先级正史。</span></span></label>
      {editing.rawData && <details className="mt-3 rounded-lg bg-gray-50 p-3"><summary className="cursor-pointer text-xs text-gray-500">查看导入时的原始字段</summary><pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all text-[10px] text-gray-500">{JSON.stringify(editing.rawData, null, 2)}</pre></details>}
      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
      <div className="mt-4 flex gap-2"><button type="button" onClick={() => setEditing(null)} className="flex-1 rounded-lg bg-gray-100 py-2.5 text-sm">取消</button>{entries.some((entry) => entry.id === editing.id) && <button type="button" onClick={() => { if (window.confirm('删除这个条目吗？')) { void db.worldbookEntries.delete(editing.id); setEditing(null) } }} className="rounded-lg bg-red-50 px-4 py-2.5 text-sm text-red-600">删除</button>}<button type="button" onClick={() => void save()} className="flex-1 rounded-lg bg-gray-900 py-2.5 text-sm text-white">保存</button></div>
    </div></div>}
  </div>
}
