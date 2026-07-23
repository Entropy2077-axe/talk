import { useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate } from 'react-router-dom'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { parseWorldbookFile, type ParsedWorldbookImport } from '../lib/worldbookImport'
import { estimateWorldbookTokens, formatEstimatedTokens } from '../lib/worldbookTokens'

const sourceNames: Record<string, string> = {
  manual: 'Talk', sillytavern: 'SillyTavern 世界书', 'character-card': 'SillyTavern 角色卡', novelai: 'NovelAI', risu: 'Risu', agnai: 'Agnai', generic: '通用 JSON',
}

export function WorldSettingsPage() {
  const navigate = useNavigate()
  const fileRef = useRef<HTMLInputElement>(null)
  const collections = useLiveQuery(() => db.worldbookCollections.orderBy('updatedAt').reverse().toArray(), []) ?? []
  const entries = useLiveQuery(() => db.worldbookEntries.toArray(), []) ?? []
  const [parsed, setParsed] = useState<ParsedWorldbookImport | null>(null)
  const [importName, setImportName] = useState('')
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState('')

  async function chooseFile(file?: File) {
    if (!file) return
    setImporting(true)
    setError('')
    try {
      const result = await parseWorldbookFile(file)
      setParsed(result)
      setImportName(result.collection.name)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setImporting(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function confirmImport() {
    if (!parsed || !importName.trim()) return
    const collection = { ...parsed.collection, name: importName.trim(), updatedAt: Date.now() }
    await db.transaction('rw', db.worldbookCollections, db.worldbookEntries, async () => {
      await db.worldbookCollections.add(collection)
      await db.worldbookEntries.bulkAdd(parsed.entries)
    })
    setParsed(null)
    navigate(`/world-settings/${collection.id}`)
  }

  async function createCollection() {
    const name = window.prompt('世界书集合名称', '新的世界书')?.trim()
    if (!name) return
    const now = Date.now()
    const id = uuid()
    await db.worldbookCollections.add({ id, name, enabled: true, sourceType: 'manual', createdAt: now, updatedAt: now })
    navigate(`/world-settings/${id}`)
  }

  return <div className="relative flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
    <TopBar title="世界书" showBack onBack={() => navigate('/discover')} />
    <div className="flex-1 overflow-y-auto px-4 pb-6">
      <section className="mt-3 rounded-xl bg-white p-4">
        <p className="text-sm font-medium text-gray-900">世界书集合</p>
        <p className="mt-1 text-xs leading-relaxed text-gray-400">支持导入世界书 JSON、.lorebook，以及带内嵌世界书的 SillyTavern PNG/JSON 角色卡。无需安装 SillyTavern。</p>
        <input ref={fileRef} type="file" accept=".json,.lorebook,.png,application/json,image/png" className="hidden" onChange={(event) => void chooseFile(event.target.files?.[0])}/>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button type="button" onClick={() => fileRef.current?.click()} disabled={importing} className="rounded-lg bg-gray-900 py-2.5 text-sm text-white disabled:opacity-50">{importing ? '解析中…' : '导入文件'}</button>
          <button type="button" onClick={() => void createCollection()} className="rounded-lg bg-gray-100 py-2.5 text-sm text-gray-700">新建集合</button>
        </div>
        {error && <p className="mt-2 text-xs leading-relaxed text-red-500">{error}</p>}
      </section>

      <div className="mt-3 space-y-3">
        {collections.map((collection) => {
          const collectionEntries = entries.filter((entry) => entry.collectionId === collection.id)
          const enabledCount = collectionEntries.filter((entry) => entry.enabled).length
          const foundationalCount = collectionEntries.filter((entry) => entry.enabled && entry.foundationalWorldview).length
          const totalTokens = estimateWorldbookTokens(collectionEntries)
          return <article key={collection.id} className="rounded-xl bg-white p-4">
            <button type="button" onClick={() => navigate(`/world-settings/${collection.id}`)} className="block w-full text-left">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium text-gray-900">{collection.name}</p>
                  <p className="mt-1 text-xs text-gray-400">{sourceNames[collection.sourceType] ?? collection.sourceLabel ?? '世界书'}{collection.sourceFileName ? ` · ${collection.sourceFileName}` : ''}</p>
                </div>
                <span className="shrink-0 text-sm text-gray-300">›</span>
              </div>
              <p className="mt-3 text-xs text-gray-500">{collectionEntries.length} 个条目 · 已启用 {enabledCount} 个{foundationalCount ? ` · 底层世界观 ${foundationalCount} 个` : ''}</p>
              <p className="mt-1 text-xs text-purple-600">总内容 {formatEstimatedTokens(totalTokens)}（估算）</p>
            </button>
            <div className="mt-3 flex items-center justify-between border-t border-gray-100 pt-3">
              <span className="text-xs text-gray-400">集合启用</span>
              <button type="button" role="switch" aria-checked={collection.enabled} onClick={() => void db.worldbookCollections.update(collection.id, { enabled: !collection.enabled, updatedAt: Date.now() })} className={`relative h-6 w-11 rounded-full transition ${collection.enabled ? 'bg-green-500' : 'bg-gray-200'}`}><span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition ${collection.enabled ? 'left-5.5' : 'left-0.5'}`}/></button>
            </div>
          </article>
        })}
        {collections.length === 0 && <div className="rounded-xl bg-white px-4 py-10 text-center"><p className="text-sm text-gray-500">还没有世界书集合</p><p className="mt-1 text-xs text-gray-400">导入 SillyTavern 世界书或新建一个集合</p></div>}
      </div>
    </div>

    {parsed && <div className="absolute inset-0 z-30 flex items-center bg-black/30 p-5">
      <div className="max-h-[90%] w-full overflow-y-auto rounded-2xl bg-white p-4">
        <h2 className="text-base font-medium text-gray-900">确认导入世界书</h2>
        <label className="mt-3 block text-xs text-gray-500">集合名称<input value={importName} onChange={(event) => setImportName(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900"/></label>
        <div className="mt-3 rounded-lg bg-gray-50 p-3 text-xs leading-relaxed text-gray-600">
          <p>来源：{parsed.collection.sourceLabel}</p>
          <p>文件：{parsed.collection.sourceFileName}</p>
          <p>有效条目：{parsed.entries.length} 个</p>
          <p>默认启用：{parsed.entries.filter((entry) => entry.enabled).length} 个</p>
          <p>无关键词常驻：{parsed.entries.filter((entry) => entry.keywords.length === 0).length} 个</p>
          <p>内容量：{formatEstimatedTokens(estimateWorldbookTokens(parsed.entries))}（估算）</p>
        </div>
        {parsed.warnings.map((warning) => <p key={warning} className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700">{warning}</p>)}
        <div className="mt-4 flex gap-2"><button type="button" onClick={() => setParsed(null)} className="flex-1 rounded-lg bg-gray-100 py-2.5 text-sm text-gray-700">取消</button><button type="button" onClick={() => void confirmImport()} disabled={!importName.trim()} className="flex-1 rounded-lg bg-gray-900 py-2.5 text-sm text-white disabled:opacity-40">确认导入</button></div>
      </div>
    </div>}
  </div>
}
