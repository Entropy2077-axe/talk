import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { estimateWorldbookTokens, formatEstimatedTokens } from '../lib/worldbookTokens'

interface Props {
  open: boolean
  selectedIds: string[]
  onChange: (ids: string[]) => void
  onClose: () => void
}

export function WorldbookEntrySelector({ open, selectedIds, onChange, onClose }: Props) {
  const collections = useLiveQuery(() => db.worldbookCollections.orderBy('updatedAt').reverse().toArray(), []) ?? []
  const entries = useLiveQuery(() => db.worldbookEntries.toArray(), []) ?? []
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string[]>([])
  const selected = useMemo(() => new Set(selectedIds), [selectedIds])
  const selectedTokens = estimateWorldbookTokens(entries.filter((entry) => selected.has(entry.id)))
  if (!open) return null

  function toggle(id: string) {
    onChange(selected.has(id) ? selectedIds.filter((value) => value !== id) : [...selectedIds, id])
  }

  const needle = query.trim().toLowerCase()
  return <div className="absolute inset-0 z-40 flex flex-col bg-[#f4f4f6]">
    <div className="flex h-12 shrink-0 items-center justify-between border-b border-gray-100 bg-white px-4"><button type="button" onClick={onClose} className="text-sm text-gray-500">取消</button><h2 className="font-medium text-gray-900">选择额外世界观</h2><button type="button" onClick={onClose} className="text-sm font-medium text-purple-600">完成</button></div>
    <div className="flex-1 overflow-y-auto px-4 pb-6">
      <div className="sticky top-0 z-10 -mx-4 bg-[#f4f4f6] px-4 py-3"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索集合、标题、关键词或正文" className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm"/><p className="mt-2 text-xs text-gray-400">已选择 {selectedIds.length} 个条目 · {formatEstimatedTokens(selectedTokens)}（估算）。选择仅影响本次人物生成，不会改变世界书开关。</p></div>
      <div className="space-y-3">{collections.map((collection) => {
        const collectionEntries = entries.filter((entry) => entry.collectionId === collection.id && (!needle || collection.name.toLowerCase().includes(needle) || entry.title.toLowerCase().includes(needle) || entry.content.toLowerCase().includes(needle) || entry.keywords.some((keyword) => keyword.toLowerCase().includes(needle))))
        if (needle && collectionEntries.length === 0) return null
        const isExpanded = needle.length > 0 || expanded.includes(collection.id)
        const selectedCount = collectionEntries.filter((entry) => selected.has(entry.id)).length
        return <section key={collection.id} className="overflow-hidden rounded-xl bg-white">
          <button type="button" onClick={() => setExpanded((current) => current.includes(collection.id) ? current.filter((id) => id !== collection.id) : [...current, collection.id])} className="flex w-full items-center justify-between gap-3 p-4 text-left"><div className="min-w-0"><p className="truncate text-sm font-medium text-gray-900">{collection.name}</p><p className="mt-1 text-xs text-gray-400">{collectionEntries.length} 个条目{selectedCount ? ` · 已选 ${selectedCount}` : ''}{!collection.enabled ? ' · 集合当前停用' : ''}</p></div><span className="text-gray-300">{isExpanded ? '⌃' : '⌄'}</span></button>
          {isExpanded && <div className="border-t border-gray-100">{collectionEntries.map((entry) => <label key={entry.id} className="flex items-start gap-3 border-b border-gray-50 px-4 py-3 last:border-0"><input type="checkbox" checked={selected.has(entry.id)} onChange={() => toggle(entry.id)} className="mt-1"/><span className="min-w-0 flex-1"><span className="block text-sm text-gray-800">{entry.title}</span><span className="mt-1 line-clamp-2 block text-xs leading-relaxed text-gray-400">{entry.content}</span><span className="mt-1 flex flex-wrap gap-1 text-[10px]"><span className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-500">{formatEstimatedTokens(estimateWorldbookTokens([entry]))}</span>{!entry.enabled && <span className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-500">当前停用</span>}{entry.foundationalWorldview && <span className="rounded bg-purple-50 px-1.5 py-0.5 text-purple-600">底层世界观</span>}{entry.keywords.length === 0 && <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-600">常驻</span>}</span></span></label>)}</div>}
        </section>
      })}{collections.length === 0 && <p className="py-12 text-center text-sm text-gray-400">请先在世界书页面导入或创建集合</p>}</div>
    </div>
  </div>
}
