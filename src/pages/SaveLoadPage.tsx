import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  Archive, BookOpen, CheckCircle2, ChevronRight, Circle, CopyPlus, Trash2,
  FilePlus2, GitBranchPlus, LoaderCircle, Pencil, Plus, Search, Sparkles,
} from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'
import { Avatar } from '../components/Avatar'
import { TopBar } from '../components/TopBar'
import { db } from '../db/db'
import { displayName } from '../lib/contact'
import {
  createEmptyWorld, createWorldBranch, createWorldSnapshot, deleteWorld, deleteWorldSnapshots,
  hydrateWorldSnapshotContacts, normalizeWorldSnapshotData, renameWorldSnapshot, restoreWorldSnapshot, switchWorld,
} from '../lib/worldSnapshots'
import { formatEstimatedTokens } from '../lib/worldbookTokens'
import { useSettingsStore } from '../store/useSettingsStore'
import type { Contact, WorldSnapshot } from '../types'

const EMPTY_SNAPSHOTS: WorldSnapshot[] = []
const dateText = (value?: number) => value ? new Date(value).toLocaleString() : '暂无备份'

export function SaveLoadPage() {
  const { worldId, snapshotId } = useParams()
  if (worldId && snapshotId) return <SnapshotDetailPage worldId={worldId} snapshotId={snapshotId} />
  if (worldId) return <WorldBackupsPage worldId={worldId} />
  return <WorldPickerPage />
}

type CreateMode = 'world' | 'branch' | 'blank-branch'

function WorldPickerPage() {
  const navigate = useNavigate()
  const settings = useSettingsStore()
  const worlds = useLiveQuery(() => db.worldbookCollections.toArray(), []) ?? []
  const entries = useLiveQuery(() => db.worldbookEntries.toArray(), []) ?? []
  const snapshots = useLiveQuery(() => db.worldSnapshots.toArray(), []) ?? EMPTY_SNAPSHOTS
  const [createMode, setCreateMode] = useState<CreateMode | null>(null)
  const [name, setName] = useState('')
  const [busyWorldId, setBusyWorldId] = useState('')
  const [batch, setBatch] = useState(false)
  const [selectedWorldIds, setSelectedWorldIds] = useState<string[]>([])
  const [confirmDeleteWorlds, setConfirmDeleteWorlds] = useState(false)
  const [error, setError] = useState('')
  const activeWorldId = settings.activeWorldId || settings.defaultWorldviewId
  const activeWorld = worlds.find((world) => world.id === activeWorldId)

  const cards = worlds.map((world) => {
    const backups = snapshots.filter((item) => item.worldId === world.id)
    const newest = [...backups].sort((a, b) => b.updatedAt - a.updatedAt)[0]
    return {
      world, backups, newest,
      entryCount: entries.filter((entry) => entry.collectionId === world.id).length,
      modifiedAt: Math.max(world.updatedAt, newest?.updatedAt ?? 0),
    }
  }).sort((a, b) => {
    const aCurrent = a.world.id === activeWorldId
    const bCurrent = b.world.id === activeWorldId
    if (aCurrent !== bCurrent) return aCurrent ? -1 : 1
    return b.modifiedAt - a.modifiedAt
  })

  function openCreate(mode: CreateMode) {
    setCreateMode(mode)
    setName(mode === 'world' ? '新的世界' : mode === 'branch' ? `${activeWorld?.name || '当前世界'} · 新分支` : `${activeWorld?.name || '当前世界'} · 空白分支`)
    setError('')
  }

  async function create() {
    if (!createMode || busyWorldId) return
    setBusyWorldId('create'); setError('')
    try {
      if (createMode === 'world') {
        await createEmptyWorld(name)
        setCreateMode(null)
      } else {
        await createWorldBranch(name, createMode === 'blank-branch')
        setCreateMode(null)
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusyWorldId('') }
  }

  async function enterWorld(worldId: string) {
    if (busyWorldId) return
    if (worldId === activeWorldId) {
      void navigate(`/save-load/world/${worldId}`)
      return
    }
    setBusyWorldId(worldId); setError('')
    try {
      await switchWorld(worldId)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusyWorldId('') }
  }

  async function removeSelectedWorlds() {
    if (!selectedWorldIds.length || busyWorldId) return
    setBusyWorldId('delete'); setError('')
    try {
      for (const worldId of selectedWorldIds) await deleteWorld(worldId)
      setSelectedWorldIds([]); setBatch(false); setConfirmDeleteWorlds(false)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusyWorldId('') }
  }

  const locked = !!busyWorldId
  return <div className="relative flex h-[var(--app-height)] flex-col overflow-hidden bg-[var(--ui-surface-2)]">
    <TopBar title="选择世界" showBack onBack={() => navigate(-1)} right={batch ? <button type="button" disabled={!selectedWorldIds.length || locked} onClick={() => setConfirmDeleteWorlds(true)} className="text-sm text-[var(--ui-danger)] disabled:opacity-40">删除</button> : undefined} />
    <div className="flex-1 overflow-y-auto px-4 pb-8">
      <section className="mt-3 overflow-hidden rounded-[var(--ui-radius-card)] border border-[var(--ui-action)] bg-[var(--ui-surface)] shadow-[var(--ui-shadow)]">
        <div className="bg-[var(--ui-action)] px-4 py-4 text-[var(--ui-on-action)]">
          <div className="flex items-center gap-2"><Sparkles size={18}/><p className="text-sm font-semibold">世界观操作</p></div>
          <p className="ui-font-display mt-1 truncate text-lg font-semibold">{activeWorld?.name || '尚未选择世界'}</p>
          <p className="mt-1 text-xs opacity-80">世界观由资料库独立管理，读取旧备份不会回滚设定。</p>
        </div>
        <div className="grid grid-cols-2 gap-2 p-3">
          <ActionButton icon={<BookOpen size={18}/>} label="编辑当前世界观" disabled={!activeWorldId || locked} onClick={() => navigate(`/library/world/${activeWorldId}`, { state: { returnTo: '/save-load' } })} />
          <ActionButton icon={<Archive size={18}/>} label="读取备份" disabled={!activeWorldId || locked} onClick={() => navigate(`/save-load/world/${activeWorldId}`)} />
        </div>
        <div className="grid grid-cols-2 gap-2 px-3 pb-3">
          <ActionButton icon={<GitBranchPlus size={18}/>} label="新建分支" disabled={!activeWorldId || locked} onClick={() => openCreate('branch')} />
          <ActionButton icon={<CopyPlus size={18}/>} label="新建空白分支" disabled={!activeWorldId || locked} onClick={() => openCreate('blank-branch')} />
        </div>
        <button type="button" disabled={locked} onClick={() => openCreate('world')} className="mx-3 mb-3 flex w-[calc(100%-1.5rem)] items-center justify-center gap-2 rounded-[var(--ui-radius-control)] border border-[var(--ui-border)] bg-[var(--ui-surface-2)] py-2.5 text-sm text-[var(--ui-text-2)] disabled:opacity-40"><Plus size={17}/>新建独立世界</button>
      </section>

      {error && <p role="alert" className="mt-3 rounded-[var(--ui-radius-control)] border border-[var(--ui-danger)] bg-[var(--ui-surface)] px-3 py-2 text-xs text-[var(--ui-danger)]">{error}</p>}

      <div className="mb-2 mt-5 flex items-center justify-between"><h2 className="text-sm font-medium text-[var(--ui-text)]">所有世界与分支</h2><button type="button" disabled={!cards.some(({ world }) => world.id !== activeWorldId) || locked} onClick={() => { setBatch((value) => !value); setSelectedWorldIds([]) }} className="flex items-center gap-1 text-xs text-[var(--ui-text-3)] disabled:opacity-40"><Trash2 size={14}/>{batch ? '取消批量' : '批量删除'}</button></div>
      <div className="space-y-2">{cards.map(({ world, backups, newest, entryCount }) => {
        const current = activeWorldId === world.id
        const loading = busyWorldId === world.id
        const checked = selectedWorldIds.includes(world.id)
        return <button type="button" key={world.id} disabled={locked || (batch && current)} onClick={() => batch ? setSelectedWorldIds((ids) => checked ? ids.filter((id) => id !== world.id) : [...ids, world.id]) : void enterWorld(world.id)} className={`flex w-full items-center gap-3 rounded-[var(--ui-radius-card)] border bg-[var(--ui-surface)] p-4 text-left shadow-[var(--ui-shadow)] disabled:opacity-60 ${current ? 'border-[var(--ui-action)] ring-2 ring-[var(--ui-accent-soft)]' : 'border-[var(--ui-border)]'}`}>
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] bg-[var(--ui-accent-soft)] text-[var(--ui-action)]">{loading ? <LoaderCircle size={21} className="animate-spin"/> : <BookOpen size={21}/>}</span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2"><span className="ui-font-display truncate text-base font-medium text-[var(--ui-text)]">{world.name}</span>{current && <span className="shrink-0 rounded-full bg-[var(--ui-accent-soft)] px-2 py-0.5 text-[10px] text-[var(--ui-action)]">当前世界</span>}</span>
            <span className="mt-1.5 block text-xs text-[var(--ui-text-3)]">{backups.length} 个备份 · {entryCount} 个世界观条目</span>
            <span className="mt-1 block text-[10px] text-[var(--ui-text-3)]">最近备份：{dateText(newest?.updatedAt)}</span>
          </span>
          {batch ? checked ? <CheckCircle2 size={21} className="text-[var(--ui-danger)]"/> : <Circle size={21} className="text-[var(--ui-text-3)]"/> : <ChevronRight size={19} className="text-[var(--ui-text-3)]"/>}
        </button>
      })}</div>
      {!cards.length && <p className="rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] py-12 text-center text-sm text-[var(--ui-text-3)]">还没有世界，请先新建一个</p>}
    </div>

    {createMode && <Modal label={createMode === 'world' ? '新建独立世界' : createMode === 'branch' ? '新建分支' : '新建空白分支'} onOutside={() => !locked && setCreateMode(null)}>
      <form onSubmit={(event) => { event.preventDefault(); void create() }}>
        <h2 className="ui-font-display text-base font-semibold text-[var(--ui-text)]">{createMode === 'world' ? '新建独立世界' : createMode === 'branch' ? '新建分支' : '新建空白分支'}</h2>
        <p className="mt-1 text-xs leading-relaxed text-[var(--ui-text-3)]">{createMode === 'world' ? '创建一个没有联系人和剧情的独立世界，创建后仍停留在这里。' : createMode === 'branch' ? '复制当前世界观、联系人和全部剧情状态。' : '复制当前世界观和联系人；聊天、记忆、关系与朋友圈从空白开始。'}</p>
        <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="世界或分支名称" className="mt-4 w-full rounded-[var(--ui-radius-control)] border border-[var(--ui-border)] bg-[var(--ui-surface-2)] px-3 py-2.5 text-sm text-[var(--ui-text)]" />
        {error && <p role="alert" className="mt-2 text-xs text-[var(--ui-danger)]">{error}</p>}
        <div className="mt-4 grid grid-cols-2 gap-2"><button type="button" disabled={locked} onClick={() => setCreateMode(null)} className="rounded-[var(--ui-radius-control)] border border-[var(--ui-border)] bg-[var(--ui-surface-2)] py-2.5 text-sm text-[var(--ui-text-2)]">取消</button><button disabled={locked || !name.trim()} className="rounded-[var(--ui-radius-control)] bg-[var(--ui-action)] py-2.5 text-sm text-[var(--ui-on-action)] disabled:opacity-40">{locked ? '处理中…' : '确认创建'}</button></div>
      </form>
    </Modal>}
    {confirmDeleteWorlds && <Modal label="删除世界" onOutside={() => !locked && setConfirmDeleteWorlds(false)}><div><h2 className="text-base font-semibold text-[var(--ui-text)]">删除 {selectedWorldIds.length} 个世界？</h2><p className="mt-2 text-sm leading-relaxed text-[var(--ui-text-2)]">将永久删除所选世界的世界观、联系人、聊天、朋友圈、记忆和全部备份。当前世界不会被删除。</p><div className="mt-4 grid grid-cols-2 gap-2"><button type="button" disabled={locked} onClick={() => setConfirmDeleteWorlds(false)} className="rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-2)] py-2.5 text-sm text-[var(--ui-text-2)]">取消</button><button type="button" disabled={locked} onClick={() => void removeSelectedWorlds()} className="rounded-[var(--ui-radius-control)] bg-[var(--ui-danger)] py-2.5 text-sm text-white">{locked ? '删除中…' : '确认删除'}</button></div></div></Modal>}
  </div>
}

function ActionButton({ icon, label, disabled, onClick }: { icon: React.ReactNode; label: string; disabled?: boolean; onClick: () => void }) {
  return <button type="button" disabled={disabled} onClick={onClick} className="flex items-center gap-2 rounded-[var(--ui-radius-control)] border border-[var(--ui-border)] bg-[var(--ui-surface-2)] px-3 py-3 text-left text-sm text-[var(--ui-text)] disabled:opacity-40"><span className="text-[var(--ui-action)]">{icon}</span><span>{label}</span></button>
}

function WorldBackupsPage({ worldId }: { worldId: string }) {
  const navigate = useNavigate()
  const world = useLiveQuery(() => db.worldbookCollections.get(worldId), [worldId])
  const snapshots = useLiveQuery(() => db.worldSnapshots.where('worldId').equals(worldId).reverse().sortBy('updatedAt'), [worldId]) ?? EMPTY_SNAPSHOTS
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<'all' | 'manual' | 'automatic'>('all')
  const [batch, setBatch] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [creating, setCreating] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const visible = useMemo(() => snapshots.filter((item) => (kind === 'all' || item.kind === kind) && (!query.trim() || item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))), [snapshots, kind, query])

  async function create() {
    setBusy(true); setMessage('')
    try { await createWorldSnapshot(worldId, `手动备份 · ${new Date().toLocaleString()}`, 'manual'); setCreating(false); setMessage('备份已创建') }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  async function removeSelected() {
    setBusy(true)
    try { await deleteWorldSnapshots(selected); setSelected([]); setBatch(false); setConfirmDelete(false); setMessage('所选备份已删除') }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  if (!world) return <PageMessage text="加载中或世界不存在" />
  return <div className="relative flex h-[var(--app-height)] flex-col overflow-hidden bg-[var(--ui-surface-2)]">
    <TopBar title={`${world.name} · 备份`} showBack onBack={() => navigate('/save-load', { replace: true })} right={batch ? <button type="button" disabled={!selected.length} onClick={() => setConfirmDelete(true)} className="text-sm text-[var(--ui-danger)] disabled:opacity-40">删除</button> : undefined}/>
    <div className="flex-1 overflow-y-auto px-4 pb-8">
      <div className="mt-3 grid grid-cols-2 gap-2"><button type="button" disabled={busy} onClick={() => setCreating(true)} className="flex items-center justify-center gap-2 rounded-[var(--ui-radius-control)] bg-[var(--ui-action)] py-2.5 text-sm text-[var(--ui-on-action)] disabled:opacity-40"><FilePlus2 size={17}/>创建备份</button><button type="button" onClick={() => { setBatch((value) => !value); setSelected([]) }} className="rounded-[var(--ui-radius-control)] border border-[var(--ui-border)] bg-[var(--ui-surface)] py-2.5 text-sm text-[var(--ui-text-2)]">{batch ? '取消批量' : '批量删除'}</button></div>
      <div className="mt-3 rounded-[var(--ui-radius-card)] border border-[var(--ui-border)] bg-[var(--ui-surface)] p-3"><label className="flex items-center gap-2"><Search size={17} className="text-[var(--ui-text-3)]"/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选备份名称" className="min-w-0 flex-1 bg-transparent text-sm text-[var(--ui-text)] outline-none"/></label><div className="mt-3 flex gap-2">{(['all','manual','automatic'] as const).map((value) => <button type="button" key={value} onClick={() => setKind(value)} className={`rounded-full px-3 py-1.5 text-xs ${kind === value ? 'bg-[var(--ui-action)] text-[var(--ui-on-action)]' : 'bg-[var(--ui-surface-2)] text-[var(--ui-text-2)]'}`}>{value === 'all' ? '全部' : value === 'manual' ? '手动备份' : '自动备份'}</button>)}</div></div>
      {message && <p className="mt-3 text-center text-xs text-[var(--ui-text-2)]">{message}</p>}
      <div className="mt-3 space-y-2">{visible.map((backup) => {
        const checked = selected.includes(backup.id)
        return <button type="button" key={backup.id} onClick={() => batch ? setSelected((current) => checked ? current.filter((id) => id !== backup.id) : [...current, backup.id]) : navigate(`/save-load/world/${worldId}/snapshot/${backup.id}`)} className="flex w-full items-center gap-3 rounded-[var(--ui-radius-card)] border border-[var(--ui-border)] bg-[var(--ui-surface)] p-4 text-left">
          <span className="min-w-0 flex-1"><span className="block truncate text-base font-medium text-[var(--ui-text)]">{backup.name}</span><span className="mt-2 block text-xs text-[var(--ui-text-3)]">{backup.contactCount} 个当时已有联系人 · {dateText(backup.createdAt)}</span><span className="mt-1 block text-[10px] text-[var(--ui-text-3)]">{backup.kind === 'automatic' ? '自动备份' : '手动备份'}</span></span>{batch ? checked ? <CheckCircle2 size={21} className="text-[var(--ui-danger)]"/> : <Circle size={21} className="text-[var(--ui-text-3)]"/> : <ChevronRight size={19} className="text-[var(--ui-text-3)]"/>}
        </button>
      })}</div>
      {!visible.length && <p className="py-12 text-center text-sm text-[var(--ui-text-3)]">没有符合条件的备份</p>}
    </div>
    {creating && <Modal label="创建备份" onOutside={() => !busy && setCreating(false)}><div><h2 className="text-base font-semibold text-[var(--ui-text)]">创建备份</h2><p className="mt-2 text-sm leading-relaxed text-[var(--ui-text-2)]">保存当前世界的联系人、聊天、朋友圈、记忆、关系、群聊和其他剧情状态。世界观条目独立管理，不随备份回滚。</p><div className="mt-4 grid grid-cols-2 gap-2"><button type="button" onClick={() => setCreating(false)} className="rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-2)] py-2.5 text-sm text-[var(--ui-text-2)]">取消</button><button type="button" disabled={busy} onClick={() => void create()} className="rounded-[var(--ui-radius-control)] bg-[var(--ui-action)] py-2.5 text-sm text-[var(--ui-on-action)]">{busy ? '创建中…' : '创建备份'}</button></div></div></Modal>}
    {confirmDelete && <Modal label="删除备份" onOutside={() => !busy && setConfirmDelete(false)}><div><h2 className="text-base font-semibold text-[var(--ui-text)]">删除 {selected.length} 个备份？</h2><p className="mt-2 text-sm leading-relaxed text-[var(--ui-text-2)]">删除后无法读取这些历史剧情状态。联系人和世界观不会被删除。</p><div className="mt-4 grid grid-cols-2 gap-2"><button type="button" onClick={() => setConfirmDelete(false)} className="rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-2)] py-2.5 text-sm text-[var(--ui-text-2)]">取消</button><button type="button" disabled={busy} onClick={() => void removeSelected()} className="rounded-[var(--ui-radius-control)] bg-[var(--ui-danger)] py-2.5 text-sm text-white">{busy ? '删除中…' : '确认删除'}</button></div></div></Modal>}
  </div>
}

function SnapshotDetailPage({ worldId, snapshotId }: { worldId: string; snapshotId: string }) {
  const navigate = useNavigate()
  const snapshot = useLiveQuery(() => db.worldSnapshots.get(snapshotId), [snapshotId])
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const hydrated = useLiveQuery(() => snapshot ? hydrateWorldSnapshotContacts(snapshot.snapshot) : undefined, [snapshot?.id, snapshot?.updatedAt])
  const normalized = snapshot ? normalizeWorldSnapshotData(snapshot.snapshot) : undefined
  const contacts = hydrated?.contacts ?? normalized?.contacts ?? []
  const missingContactCount = Math.max(0, (normalized?.contactIds?.length ?? 0) - contacts.length)

  if (!snapshot) return <PageMessage text="加载中或备份不存在" />

  async function rename() {
    try { await renameWorldSnapshot(snapshotId, name); setRenaming(false) }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
  }
  async function restore() {
    setBusy(true); setMessage('')
    try { await restoreWorldSnapshot(snapshotId); void navigate('/', { replace: true }) }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); setBusy(false) }
  }

  return <div className="relative flex h-[var(--app-height)] flex-col overflow-hidden bg-[var(--ui-surface-2)]">
    <TopBar title="备份详情" showBack onBack={() => navigate(`/save-load/world/${worldId}`, { replace: true })}/>
    <div className="flex-1 overflow-y-auto px-4 pb-8">
      <section className="mt-3 rounded-[var(--ui-radius-card)] border border-[var(--ui-border)] bg-[var(--ui-surface)] p-4">
        <button type="button" onClick={() => { setName(snapshot.name); setRenaming(true) }} className="flex w-full items-center justify-between text-left"><span className="ui-font-display text-lg font-semibold text-[var(--ui-text)]">{snapshot.name}</span><Pencil size={16} className="text-[var(--ui-text-3)]"/></button>
        <div className="mt-4 space-y-2 text-sm text-[var(--ui-text-2)]"><p>当前世界观提示词预计消耗：{formatEstimatedTokens(snapshot.estimatedWorldviewTokens)}</p><p>创建时已有联系人：{snapshot.contactCount}</p><p className="text-xs text-[var(--ui-text-3)]">创建时间：{dateText(snapshot.createdAt)} · {snapshot.kind === 'automatic' ? '自动备份' : '手动备份'}</p></div>
        <button type="button" disabled={busy} onClick={() => void restore()} className="mt-4 flex w-full items-center justify-center gap-2 rounded-[var(--ui-radius-control)] bg-[var(--ui-action)] py-3 text-sm font-medium text-[var(--ui-on-action)] disabled:opacity-50">{busy ? <><LoaderCircle size={17} className="animate-spin"/>正在读取…</> : <><Archive size={17}/>读取备份</>}</button>
      </section>
      <p className="mt-4 text-xs text-[var(--ui-text-3)]">以下联系人在创建备份时已经存在。当前后来新增的联系人不会消失，只会在这个世界中回到空白剧情状态。</p>
      <div className="mt-2 space-y-2">{contacts.map((contact: Contact) => <article key={contact.id} className="flex items-center gap-3 rounded-[var(--ui-radius-card)] border border-[var(--ui-border)] bg-[var(--ui-surface)] p-3"><Avatar avatar={contact.avatar} color={contact.avatarColor} size={44}/><div className="min-w-0"><p className="truncate text-sm font-medium text-[var(--ui-text)]">{displayName(contact)}</p><p className="mt-1 text-xs text-[var(--ui-text-3)]">属于这个世界的联系人</p></div></article>)}</div>
      {!contacts.length && !missingContactCount && <p className="mt-3 rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] py-10 text-center text-sm text-[var(--ui-text-3)]">这个备份创建时还没有联系人</p>}
      {missingContactCount > 0 && <p role="alert" className="mt-3 rounded-[var(--ui-radius-card)] border border-[var(--ui-danger)] bg-[var(--ui-surface)] px-4 py-4 text-sm leading-relaxed text-[var(--ui-danger)]">这个旧备份还有 {missingContactCount} 位联系人只保留了 ID，暂时找不到完整资料。为避免联系人被清空，读取时会自动阻止并保留当前数据。</p>}
      {message && <p role="alert" className="mt-3 text-center text-xs text-[var(--ui-danger)]">{message}</p>}
    </div>
    {renaming && <Modal label="修改备份名称" onOutside={() => setRenaming(false)}><form onSubmit={(event) => { event.preventDefault(); void rename() }}><h2 className="text-base font-semibold text-[var(--ui-text)]">修改备份名称</h2><input autoFocus value={name} onChange={(event) => setName(event.target.value)} className="mt-4 w-full rounded-[var(--ui-radius-control)] border border-[var(--ui-border)] bg-[var(--ui-surface-2)] px-3 py-2.5 text-sm text-[var(--ui-text)]"/><div className="mt-4 grid grid-cols-2 gap-2"><button type="button" onClick={() => setRenaming(false)} className="rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-2)] py-2.5 text-sm text-[var(--ui-text-2)]">取消</button><button className="rounded-[var(--ui-radius-control)] bg-[var(--ui-action)] py-2.5 text-sm text-[var(--ui-on-action)]">保存</button></div></form></Modal>}
  </div>
}

function Modal({ label, onOutside, children }: { label: string; onOutside: () => void; children: React.ReactNode }) {
  return <div className="absolute inset-0 z-40 flex items-end bg-black/30 p-4 sm:items-center" role="dialog" aria-label={label} aria-modal="true" onMouseDown={(event) => { if (event.target === event.currentTarget) onOutside() }}><div className="mx-auto w-full max-w-sm rounded-[var(--ui-radius-card)] border border-[var(--ui-border)] bg-[var(--ui-surface)] p-4 shadow-xl">{children}</div></div>
}

function PageMessage({ text }: { text: string }) {
  const navigate = useNavigate()
  return <div className="flex h-[var(--app-height)] flex-col bg-[var(--ui-surface-2)]"><TopBar title="选择世界" showBack onBack={() => navigate('/save-load', { replace: true })}/><div className="flex flex-1 items-center justify-center text-sm text-[var(--ui-text-3)]">{text}</div></div>
}
