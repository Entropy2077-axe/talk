import { useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { useSettingsStore } from '../store/useSettingsStore'
import { searchKnowledgeTopic } from '../lib/knowledgeBase'
import { characterCardPersonaText, parseSillyTavernCharacterCard } from '../lib/characterCardImport'
import { parseWorldbookFile } from '../lib/worldbookImport'
import { searchLibraryItems, storeCharacterCardInLibrary, storeWorldbookInLibrary } from '../lib/library'
import type { LibrarySourceType } from '../types'
import { v4 as uuid } from 'uuid'
import { Navigate, useSearchParams } from 'react-router-dom'

const SOURCE_LABELS: Record<LibrarySourceType, string> = {
  'character-card': '角色卡', worldbook: '导入世界书资料', web: '联网', manual: '手写', legacy: '旧资料',
}
const EMPTY_ITEMS: never[] = []

export function KnowledgeBasePage() {
  const [searchParams] = useSearchParams()
  const worldviewView = searchParams.get('view') === 'worldview'
  const albumView = searchParams.get('view') === 'album'
  const settings = useSettingsStore()
  const fileRef = useRef<HTMLInputElement>(null)
  const items = useLiveQuery(() => db.libraryItems.toArray(), []) ?? EMPTY_ITEMS
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<LibrarySourceType | 'all'>('all')
  const [webQuery, setWebQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [manualOpen, setManualOpen] = useState(false)
  const [manualTitle, setManualTitle] = useState('')
  const [manualContent, setManualContent] = useState('')
  const [manualKeywords, setManualKeywords] = useState('')
  const [manualError, setManualError] = useState('')
  const [savingManual, setSavingManual] = useState(false)
  const visible = useMemo(() => searchLibraryItems(source === 'all' ? items : items.filter((item) => item.sourceType === source), query), [items, query, source])

  async function importFile(file?: File) {
    if (!file) return
    setBusy(true); setMessage('')
    try {
      let card: Awaited<ReturnType<typeof parseSillyTavernCharacterCard>> | undefined
      try {
        const parsed = await parseSillyTavernCharacterCard(file, settings.userNickname || '用户')
        if ([parsed.description, parsed.personality, parsed.scenario, parsed.firstMessage, parsed.systemPrompt].some(Boolean)) card = parsed
      } catch {}
      let lore: Awaited<ReturnType<typeof parseWorldbookFile>> | undefined
      try { lore = await parseWorldbookFile(file) } catch {}
      if (card) {
        await storeCharacterCardInLibrary({ name: card.name, content: characterCardPersonaText(card), keywords: card.tags, rawData: card.raw, sourceFileName: file.name }, lore)
        setMessage(`已将角色卡${lore ? `及其 ${lore.entries.length} 条内嵌世界书` : ''}导入资料库`)
      } else if (lore) {
        await storeWorldbookInLibrary(lore.collection, lore.entries)
        setMessage(`已导入 ${lore.entries.length} 条资料`)
      } else throw new Error('没有识别到角色卡或世界书资料')
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = '' }
  }

  async function searchWeb() {
    if (!webQuery.trim()) return
    setBusy(true); setMessage('')
    try {
      const result = await searchKnowledgeTopic(webQuery.trim(), settings)
      setMessage(result.message ?? `新增了 ${result.addedCount} 条联网资料`)
      if (!result.message) setWebQuery('')
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  async function addManual() {
    const title = manualTitle.trim()
    const content = manualContent.trim()
    if (!title || !content) {
      setManualError(!title ? '请输入资料标题' : '请输入资料正文')
      return
    }
    setSavingManual(true)
    setManualError('')
    try {
      const now = Date.now()
      await db.libraryItems.add({ id: uuid(), sourceType: 'manual', title, content, keywords: [...new Set(manualKeywords.split(/[、,，\n]+/).map((value) => value.trim()).filter(Boolean))], sourceLabel: '用户手写', createdAt: now, updatedAt: now })
      setMessage('已添加手写资料')
      setManualOpen(false)
    } catch (error) {
      setManualError(error instanceof Error ? error.message : String(error))
    } finally {
      setSavingManual(false)
    }
  }

  function openManualDialog() {
    setManualTitle('')
    setManualContent('')
    setManualKeywords('')
    setManualError('')
    setManualOpen(true)
  }

  if (worldviewView) return <Navigate to="/save-load" replace />
  if (albumView) return <Navigate to="/album" replace />

  return <div className="relative flex h-[var(--app-height)] flex-col overflow-hidden bg-[var(--ui-bg)]">
    <TopBar title="资料库" showBack />
    <div className="flex-1 overflow-y-auto px-4 pb-8">
      <section className="mt-3 rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] p-4 shadow-[var(--ui-shadow)]">
        <p className="text-xs font-medium text-[var(--ui-text-3)]">普通资料</p>
        <h1 className="ui-font-display mt-1 text-lg font-semibold text-[var(--ui-text)]">收集以后可能用到的参考</h1>
        <p className="mt-1 text-xs leading-relaxed text-gray-400">角色卡、外部世界书和联网结果都会先保存在这里。资料不会自动成为世界正史。</p>
        <input ref={fileRef} type="file" accept=".json,.lorebook,.png,application/json,image/png" className="hidden" onChange={(event) => void importFile(event.target.files?.[0])}/>
        <div className="mt-3 grid grid-cols-2 gap-2"><button type="button" disabled={busy} onClick={() => fileRef.current?.click()} className="rounded-lg bg-gray-900 py-2.5 text-sm text-white disabled:opacity-50">{busy ? '处理中…' : '导入文件'}</button><button type="button" onClick={openManualDialog} className="rounded-lg bg-gray-100 py-2.5 text-sm text-gray-700">手写资料</button></div>
        <div className="mt-2 flex gap-2"><input value={webQuery} onChange={(event) => setWebQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void searchWeb() }} placeholder="联网搜索新词、作品或资料" className="min-w-0 flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm"/><button type="button" disabled={busy || !webQuery.trim()} onClick={() => void searchWeb()} className="rounded-lg bg-gray-100 px-4 text-sm text-gray-700 disabled:opacity-40">搜索</button></div>
        {message && <p className="mt-2 text-xs leading-relaxed text-gray-500">{message}</p>}
      </section>

      <div className="sticky top-0 z-10 -mx-4 mt-3 bg-[var(--ui-bg)] px-4 py-2">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索资料名、关键词、来源或正文" className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm"/>
        <div className="mt-2 flex gap-2 overflow-x-auto">{(['all','character-card','worldbook','web','manual'] as const).map((value) => <button type="button" key={value} onClick={() => setSource(value)} className={`shrink-0 rounded-full px-3 py-1.5 text-xs ${source === value ? 'bg-gray-900 text-white' : 'bg-white text-gray-500'}`}>{value === 'all' ? '全部' : SOURCE_LABELS[value]}</button>)}</div>
      </div>

      <div className="space-y-2">{visible.map((item) => <article key={item.id} className="rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] p-4 shadow-[var(--ui-shadow)]">
        <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="font-medium text-gray-900">{item.title}</p><p className="mt-1 line-clamp-3 text-sm leading-relaxed text-gray-500">{item.content || '（资料包）'}</p></div>{'matchPercent' in item && query.trim() && <span className="shrink-0 rounded-full bg-green-50 px-2 py-1 text-[10px] text-green-700">{Number(item.matchPercent)}%匹配</span>}</div>
        <div className="mt-2 flex flex-wrap gap-1.5 text-[10px]"><span className="rounded-full bg-gray-100 px-2 py-1 text-gray-500">{SOURCE_LABELS[item.sourceType]}</span>{item.keywords.slice(0, 4).map((keyword) => <span key={keyword} className="rounded-full bg-blue-50 px-2 py-1 text-blue-600">{keyword}</span>)}{item.sourceFileName && <span className="truncate rounded-full bg-gray-50 px-2 py-1 text-gray-400">{item.sourceFileName}</span>}</div>
        <button type="button" onClick={() => void db.libraryItems.delete(item.id)} className="mt-3 text-xs text-red-500">删除资料</button>
      </article>)}{visible.length === 0 && <p className="py-12 text-center text-sm text-gray-400">没有符合条件的资料</p>}</div>
    </div>
    {manualOpen && <div className="absolute inset-0 z-40 flex items-end bg-black/30 p-4 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="manual-library-title" onMouseDown={(event) => { if (event.target === event.currentTarget && !savingManual) setManualOpen(false) }}>
      <form className="mx-auto max-h-[90%] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-4 shadow-xl" onSubmit={(event) => { event.preventDefault(); void addManual() }}>
        <h2 id="manual-library-title" className="text-base font-semibold text-gray-900">添加手写资料</h2>
        <p className="mt-1 text-xs leading-relaxed text-gray-400">资料会保存到资料库，不会自动写入当前世界观。</p>
        <label className="mt-4 block text-xs text-gray-500">资料标题
          <input autoFocus value={manualTitle} onChange={(event) => { setManualTitle(event.target.value); setManualError('') }} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm" placeholder="输入一个容易搜索的标题" />
        </label>
        <label className="mt-3 block text-xs text-gray-500">资料正文
          <textarea value={manualContent} onChange={(event) => { setManualContent(event.target.value); setManualError('') }} rows={7} className="mt-1 w-full resize-y rounded-lg border border-gray-200 px-3 py-2.5 text-sm leading-relaxed" placeholder="输入人物、地点、设定或其他参考资料" />
        </label>
        <label className="mt-3 block text-xs text-gray-500">关键词（可选）
          <input value={manualKeywords} onChange={(event) => setManualKeywords(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm" placeholder="用逗号或顿号分隔" />
        </label>
        {manualError && <p role="alert" className="mt-2 text-xs text-red-500">{manualError}</p>}
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button type="button" disabled={savingManual} onClick={() => setManualOpen(false)} className="rounded-lg bg-gray-100 py-2.5 text-sm text-gray-600 disabled:opacity-50">取消</button>
          <button type="submit" disabled={savingManual} className="rounded-lg bg-gray-900 py-2.5 text-sm text-white disabled:opacity-50">{savingManual ? '保存中…' : '保存资料'}</button>
        </div>
      </form>
    </div>}
  </div>
}
