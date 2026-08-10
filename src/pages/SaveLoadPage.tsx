import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { ChevronRight, Circle, CheckCircle2, Pencil } from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'
import { Avatar } from '../components/Avatar'
import { TopBar } from '../components/TopBar'
import { db } from '../db/db'
import { displayName } from '../lib/contact'
import {
  createEmptyWorld, createWorldSnapshot, deleteWorldSnapshots, renameWorldSnapshot, restoreWorldSnapshot,
} from '../lib/worldSnapshots'
import { formatEstimatedTokens } from '../lib/worldbookTokens'
import { useSettingsStore } from '../store/useSettingsStore'
import type { Contact, WorldSnapshot } from '../types'

const EMPTY_SNAPSHOTS: WorldSnapshot[] = []
const dateText = (value?: number) => value ? new Date(value).toLocaleString() : '暂无存档'

export function SaveLoadPage() {
  const { worldId, snapshotId } = useParams()
  if (worldId && snapshotId) return <SnapshotDetailPage worldId={worldId} snapshotId={snapshotId} />
  if (worldId) return <WorldSavesPage worldId={worldId} />
  return <WorldPickerPage />
}

function WorldPickerPage() {
  const navigate = useNavigate()
  const settings = useSettingsStore()
  const worlds = useLiveQuery(() => db.worldbookCollections.toArray(), []) ?? []
  const snapshots = useLiveQuery(() => db.worldSnapshots.toArray(), []) ?? EMPTY_SNAPSHOTS
  const conversations = useLiveQuery(() => db.conversations.toArray(), []) ?? []
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('新的世界')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const cards = worlds.map((world) => {
    const saves = snapshots.filter((save) => save.worldId === world.id)
    const newest = [...saves].sort((a, b) => b.updatedAt - a.updatedAt)[0]
    const activeConversationAt = settings.activeWorldId === world.id
      ? Math.max(0, ...conversations.map((item) => item.updatedAt)) : 0
    return { world, saves, newest, modifiedAt: Math.max(world.updatedAt, newest?.updatedAt ?? 0, activeConversationAt) }
  }).sort((a, b) => b.modifiedAt - a.modifiedAt)

  async function create() {
    setBusy(true); setError('')
    try {
      const world = await createEmptyWorld(name)
      setCreateOpen(false)
      void navigate(`/save-load/world/${world.id}`)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }

  return <div className="relative flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
    <TopBar title="选择世界" showBack />
    <div className="flex-1 overflow-y-auto px-4 pb-8">
      <section className="mt-3 rounded-xl bg-white p-4">
        <div className="flex items-start justify-between gap-3">
          <div><p className="text-sm font-medium text-gray-900">世界观操作</p><p className="mt-1 text-xs leading-relaxed text-gray-400">创建世界、管理当前世界正史及资料导入规则。</p></div>
          <button type="button" onClick={() => { setName('新的世界'); setError(''); setCreateOpen(true) }} className="shrink-0 rounded-lg bg-gray-900 px-3 py-2 text-xs text-white">新建世界观</button>
        </div>
        <button type="button" disabled={!settings.activeWorldId} onClick={() => navigate(`/save-load/world/${settings.activeWorldId}/edit`)} className="mt-3 flex w-full items-center justify-between rounded-lg bg-gray-50 px-3 py-2.5 text-left text-sm text-gray-700 disabled:opacity-40"><span>管理当前世界观内容</span><ChevronRight size={17} className="text-gray-300" /></button>
        <div className="mt-3 flex items-center justify-between border-t border-gray-100 pt-3"><div><p className="text-sm text-gray-800">自动压缩大段材料</p><p className="mt-1 text-[11px] text-gray-400">超过阈值时由 AI 整理，关闭后原样加入。</p></div><button type="button" role="switch" aria-checked={settings.autoCompressLibraryImports !== false} onClick={() => settings.setSettings({ autoCompressLibraryImports: settings.autoCompressLibraryImports === false })} className={`relative h-6 w-11 shrink-0 rounded-full ${settings.autoCompressLibraryImports !== false ? 'bg-green-500' : 'bg-gray-200'}`}><span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition ${settings.autoCompressLibraryImports !== false ? 'left-5.5' : 'left-0.5'}`} /></button></div>
        <label className="mt-3 block text-xs text-gray-500">压缩阈值（Token）<input type="number" min="200" step="100" value={settings.libraryCompressionThresholdTokens ?? 2000} onChange={(event) => settings.setSettings({ libraryCompressionThresholdTokens: Math.max(200, Math.floor(Number(event.target.value) || 2000)) })} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" /></label>
      </section>
      <div className="mt-3 space-y-2">{cards.map(({ world, saves, newest }) => <button type="button" key={world.id} onClick={() => navigate(`/save-load/world/${world.id}`)} className="flex w-full items-center gap-3 rounded-xl bg-white p-4 text-left active:bg-gray-50"><span className="min-w-0 flex-1"><span className="flex items-center gap-2"><span className="truncate text-base font-medium text-gray-900">{world.name}</span>{settings.activeWorldId === world.id && <span className="shrink-0 rounded-full bg-green-50 px-2 py-0.5 text-[10px] text-green-600">当前世界</span>}</span><span className="mt-2 block text-xs text-gray-400">{saves.length} 个存档 · 最近存档：{dateText(newest?.updatedAt)}</span></span><ChevronRight size={19} className="text-gray-300" /></button>)}</div>
      {!cards.length && <p className="mt-3 rounded-xl bg-white py-10 text-center text-sm text-gray-400">还没有世界</p>}
    </div>
    {createOpen && <Modal onOutside={() => setCreateOpen(false)}><form onSubmit={(event) => { event.preventDefault(); void create() }}><h2 className="text-base font-semibold text-gray-900">新建世界观</h2><p className="mt-1 text-xs text-gray-400">创建后会先生成一份空世界自动存档，不会立即切换世界。</p><input autoFocus value={name} onChange={(event) => { setName(event.target.value); setError('') }} className="mt-4 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm" placeholder="世界名称" />{error && <p className="mt-2 text-xs text-red-500">{error}</p>}<div className="mt-4 grid grid-cols-2 gap-2"><button type="button" onClick={() => setCreateOpen(false)} className="rounded-lg bg-gray-100 py-2.5 text-sm text-gray-600">取消</button><button disabled={busy} className="rounded-lg bg-gray-900 py-2.5 text-sm text-white disabled:opacity-50">{busy ? '创建中…' : '创建'}</button></div></form></Modal>}
  </div>
}

type Filter = 'all' | 'manual' | 'automatic'

function WorldSavesPage({ worldId }: { worldId: string }) {
  const navigate = useNavigate()
  const world = useLiveQuery(() => db.worldbookCollections.get(worldId), [worldId])
  const snapshots = useLiveQuery(() => db.worldSnapshots.where('worldId').equals(worldId).reverse().sortBy('updatedAt'), [worldId]) ?? EMPTY_SNAPSHOTS
  const [filter, setFilter] = useState<Filter>('all')
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [batch, setBatch] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const visible = snapshots.filter((save) => filter === 'all' || save.kind === filter)

  function nextDefaultName() {
    const max = snapshots.reduce((value, save) => Math.max(value, Number(save.name.match(/^新建存档-(\d+)$/)?.[1] ?? 0)), 0)
    return `新建存档-${String(max + 1).padStart(2, '0')}`
  }

  async function create() {
    setBusy(true); setMessage('')
    try {
      await createWorldSnapshot(worldId, name.trim() || nextDefaultName(), 'manual')
      setCreateOpen(false); setName(''); setMessage('存档已创建')
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }

  async function removeSelected() {
    setBusy(true)
    try { await deleteWorldSnapshots(selected); setSelected([]); setBatch(false); setConfirmDelete(false); setMessage('所选存档已删除') }
    finally { setBusy(false) }
  }

  if (!world) return <PageMessage text="世界不存在或正在加载" />
  return <div className="relative flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
    <TopBar title={world.name} showBack onBack={() => navigate('/save-load')} right={batch ? <button type="button" disabled={!selected.length} onClick={() => setConfirmDelete(true)} className="text-sm text-red-500 disabled:text-gray-300">确认删除</button> : undefined} />
    <div className="flex-1 overflow-y-auto px-4 pb-8">
      <button type="button" onClick={() => { setName(''); setCreateOpen(true) }} className="mt-3 w-full rounded-xl bg-gray-900 py-3 text-sm font-medium text-white">新建存档</button>
      <button type="button" onClick={() => { setBatch((value) => !value); setSelected([]) }} className="mt-2 w-full rounded-xl bg-white py-3 text-sm text-gray-700">{batch ? '取消批量删除' : '批量删除存档'}</button>
      <button type="button" onClick={() => navigate(`/save-load/world/${worldId}/edit`)} className="mt-2 flex w-full items-center justify-between rounded-xl bg-white px-4 py-3 text-sm text-gray-700"><span>编辑世界观内容</span><ChevronRight size={17} className="text-gray-300" /></button>
      <div className="mt-3 grid grid-cols-3 rounded-lg bg-gray-200 p-1">{([['all', 'All'], ['manual', '仅手动存档'], ['automatic', '仅自动存档']] as const).map(([value, label]) => <button key={value} type="button" onClick={() => setFilter(value)} className={`rounded-md py-2 text-xs ${filter === value ? 'bg-white font-medium text-gray-900 shadow-sm' : 'text-gray-500'}`}>{label}</button>)}</div>
      <div className="mt-3 space-y-2">{visible.map((save) => { const checked = selected.includes(save.id); return <button type="button" key={save.id} onClick={() => batch ? setSelected((current) => checked ? current.filter((id) => id !== save.id) : [...current, save.id]) : navigate(`/save-load/world/${worldId}/snapshot/${save.id}`)} className="flex w-full items-center gap-3 rounded-xl bg-white p-4 text-left active:bg-gray-50"><span className="min-w-0 flex-1"><span className="block truncate text-base font-medium text-gray-900">{save.name}</span><span className="mt-2 block text-xs text-gray-400">{save.contactCount} 个联系人 · {dateText(save.createdAt)}</span><span className="mt-1 block text-[10px] text-gray-400">{save.kind === 'automatic' ? '自动存档' : '手动存档'}</span></span>{batch ? checked ? <CheckCircle2 size={21} className="text-red-500" /> : <Circle size={21} className="text-gray-300" /> : <ChevronRight size={19} className="text-gray-300" />}</button> })}</div>
      {!visible.length && <p className="mt-3 rounded-xl bg-white py-10 text-center text-sm text-gray-400">当前分类暂无存档</p>}
      {message && <p className="mt-3 text-center text-xs text-gray-500">{message}</p>}
    </div>
    {createOpen && <Modal onOutside={() => setCreateOpen(false)}><form onSubmit={(event) => { event.preventDefault(); void create() }}><h2 className="text-base font-semibold text-gray-900">新建存档</h2><p className="mt-1 text-xs text-gray-400">名称留空时将使用“{nextDefaultName()}”。</p><input autoFocus value={name} onChange={(event) => setName(event.target.value)} className="mt-4 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm" placeholder={nextDefaultName()} /><div className="mt-4 grid grid-cols-2 gap-2"><button type="button" onClick={() => setCreateOpen(false)} className="rounded-lg bg-gray-100 py-2.5 text-sm text-gray-600">取消</button><button disabled={busy} className="rounded-lg bg-gray-900 py-2.5 text-sm text-white disabled:opacity-50">确认创建</button></div></form></Modal>}
    {confirmDelete && <Modal onOutside={() => setConfirmDelete(false)}><h2 className="text-base font-semibold text-gray-900">确认删除存档</h2><p className="mt-2 text-sm leading-relaxed text-gray-500">确定删除选中的 {selected.length} 个存档吗？删除后无法恢复。</p><div className="mt-4 grid grid-cols-2 gap-2"><button type="button" onClick={() => setConfirmDelete(false)} className="rounded-lg bg-gray-100 py-2.5 text-sm text-gray-600">取消</button><button type="button" disabled={busy} onClick={() => void removeSelected()} className="rounded-lg bg-red-500 py-2.5 text-sm text-white disabled:opacity-50">确认删除</button></div></Modal>}
  </div>
}

function SnapshotDetailPage({ worldId, snapshotId }: { worldId: string; snapshotId: string }) {
  const navigate = useNavigate()
  const snapshot = useLiveQuery(() => db.worldSnapshots.get(snapshotId), [snapshotId])
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const contacts = useMemo(() => {
    const rows = snapshot?.snapshot.tables.contacts
    return (Array.isArray(rows) ? rows as Contact[] : []).slice().sort((a, b) => b.createdAt - a.createdAt)
  }, [snapshot])

  async function rename() {
    try { await renameWorldSnapshot(snapshotId, name); setRenaming(false) }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)) }
  }

  async function restore() {
    if (!window.confirm('调用存档会先自动保存当前世界，再切换到这份世界存档。确定继续吗？')) return
    setBusy(true); setMessage('正在自动保存并切换世界…')
    try { await restoreWorldSnapshot(snapshotId); void navigate('/') }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); setBusy(false) }
  }

  if (!snapshot || snapshot.worldId !== worldId) return <PageMessage text="存档不存在或正在加载" />
  return <div className="relative flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
    <TopBar title="存档详情" showBack onBack={() => navigate(`/save-load/world/${worldId}`)} />
    <div className="flex-1 overflow-y-auto px-4 pb-8">
      <section className="mt-3 rounded-xl bg-white p-4">
        <button type="button" onClick={() => { setName(snapshot.name); setRenaming(true) }} className="flex w-full items-center justify-between text-left"><span className="text-lg font-semibold text-gray-900">{snapshot.name}</span><Pencil size={16} className="text-gray-400" /></button>
        <div className="mt-4 space-y-2 text-sm text-gray-600"><p>世界观提示词预计消耗：{formatEstimatedTokens(snapshot.estimatedWorldviewTokens)}</p><p>世界内部人数：{snapshot.contactCount}</p><p className="text-xs text-gray-400">创建时间：{dateText(snapshot.createdAt)} · {snapshot.kind === 'automatic' ? '自动存档' : '手动存档'}</p></div>
        <button type="button" disabled={busy} onClick={() => void restore()} className="mt-4 w-full rounded-lg bg-gray-900 py-3 text-sm font-medium text-white disabled:opacity-50">{busy ? '正在调用…' : '调用存档'}</button>
      </section>
      <div className="mt-3 space-y-2">{contacts.map((contact) => <article key={contact.id} className="flex items-center gap-3 rounded-xl bg-white p-3"><Avatar avatar={contact.avatar} color={contact.avatarColor} size={44} /><div className="min-w-0"><p className="truncate text-sm font-medium text-gray-900">{displayName(contact)}</p><p className="mt-1 text-xs text-gray-400">创建于 {dateText(contact.createdAt)}</p></div></article>)}</div>
      {!contacts.length && <p className="mt-3 rounded-xl bg-white py-10 text-center text-sm text-gray-400">这个存档中没有联系人</p>}
      {message && <p className="mt-3 text-center text-xs text-gray-500">{message}</p>}
    </div>
    {renaming && <Modal onOutside={() => setRenaming(false)}><form onSubmit={(event) => { event.preventDefault(); void rename() }}><h2 className="text-base font-semibold text-gray-900">修改存档名称</h2><input autoFocus value={name} onChange={(event) => setName(event.target.value)} className="mt-4 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm" /><div className="mt-4 grid grid-cols-2 gap-2"><button type="button" onClick={() => setRenaming(false)} className="rounded-lg bg-gray-100 py-2.5 text-sm text-gray-600">取消</button><button className="rounded-lg bg-gray-900 py-2.5 text-sm text-white">保存</button></div></form></Modal>}
  </div>
}

function Modal({ onOutside, children }: { onOutside: () => void; children: React.ReactNode }) {
  return <div className="absolute inset-0 z-40 flex items-end bg-black/30 p-4 sm:items-center" role="dialog" aria-label="新建世界观" aria-modal="true" onMouseDown={(event) => { if (event.target === event.currentTarget) onOutside() }}><div className="mx-auto w-full max-w-sm rounded-2xl bg-white p-4 shadow-xl">{children}</div></div>
}

function PageMessage({ text }: { text: string }) {
  return <div className="flex h-[var(--app-height)] flex-col bg-[#f4f4f6]"><TopBar title="存档与回档" showBack /><div className="flex flex-1 items-center justify-center text-sm text-gray-400">{text}</div></div>
}
