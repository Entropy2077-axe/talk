import { useEffect, useMemo, useState, type ChangeEvent } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { MapPinned, Plus, RotateCcw, Upload, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { db } from '../db/db'
import { isAiTestId } from '../lib/aiTestIsolation'
import { TopBar } from '../components/TopBar'
import { LocationMapCanvas } from '../components/LocationMapCanvas'
import { Avatar } from '../components/Avatar'
import { getLocationIcon, LOCATION_ICON_CATEGORIES, LOCATION_ICON_OPTIONS, type LocationIconOption } from '../lib/locationIcons'
import { isLocationPlacementAvailable } from '../lib/locationMap'
import { childLocations, deleteLocationTree, enterLocation, realSeason, regenerateLocationMap, syncContactLocationsAt } from '../lib/locations'
import type { Contact, LocationAudibility, LocationNode, TerrainType } from '../types'

const EMPTY_LOCATIONS: LocationNode[] = []
const EMPTY_CONTACTS: Contact[] = []
const ALL_TERRAINS: TerrainType[] = ['river', 'grassland', 'beach', 'hill', 'mountain', 'urban', 'rural']

interface LocationFormState {
  name: string
  description: string
  note: string
  access: LocationNode['access']
  iconId: string
  customIconDataUrl?: string
}

interface ChildFormState {
  name: string
  description: string
  access: LocationNode['access']
}

const EMPTY_FORM: LocationFormState = { name: '', description: '', note: '', access: 'public', iconId: 'custom' }
const EMPTY_CHILD_FORM: ChildFormState = { name: '', description: '', access: 'public' }

function readImage(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('图片读取失败'))
    reader.onerror = () => reject(reader.error ?? new Error('图片读取失败'))
    reader.readAsDataURL(file)
  })
}

export function LocationsPage() {
  const navigate = useNavigate()
  const [selectedId, setSelectedId] = useState<string>()
  const [error, setError] = useState('')
  const [entering, setEntering] = useState('')
  const [now, setNow] = useState(() => new Date())
  const [formMode, setFormMode] = useState<'new' | 'edit'>()
  const [form, setForm] = useState<LocationFormState>(EMPTY_FORM)
  const [draftPoint, setDraftPoint] = useState<{ x: number; y: number }>()
  const [movingId, setMovingId] = useState<string>()
  const [iconSearch, setIconSearch] = useState('')
  const [iconCategory, setIconCategory] = useState<'全部' | LocationIconOption['category']>('全部')
  const [childForm, setChildForm] = useState<ChildFormState>()
  const [editingChildId, setEditingChildId] = useState<string>()
  const [regenerating, setRegenerating] = useState(false)

  useEffect(() => {
    const sync = () => void syncContactLocationsAt(new Date()).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
    sync(); const timer = window.setInterval(() => { setNow(new Date()); sync() }, 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const map = useLiveQuery(() => db.worldMaps.get('active'), [])
  const locations = useLiveQuery(() => db.locations.orderBy('sortOrder').toArray(), []) ?? EMPTY_LOCATIONS
  const state = useLiveQuery(() => db.locationModuleState.get('active'), [])
  const acousticEdges = useLiveQuery(() => db.acousticEdges.toArray(), []) ?? []
  const contacts = (useLiveQuery(() => db.contacts.toArray(), []) ?? EMPTY_CONTACTS).filter((item) => !isAiTestId(item.id))
  const active = locations.find((item) => item.id === state?.currentLocationId)
  const selected = locations.find((item) => item.id === selectedId)
  const children = useMemo(() => selected ? childLocations(selected.id, locations) : [], [locations, selected])
  const timeText = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(now)
  const selectedPeople = useMemo(() => {
    if (!selected) return []
    const ids = new Set([selected.id])
    let changed = true
    while (changed) {
      changed = false
      for (const item of locations) if (item.parentId && ids.has(item.parentId) && !ids.has(item.id)) { ids.add(item.id); changed = true }
    }
    return contacts.filter((contact) => !!contact.currentLocationId && ids.has(contact.currentLocationId))
  }, [contacts, locations, selected])
  const filteredIcons = useMemo(() => {
    const query = iconSearch.trim().toLocaleLowerCase()
    return LOCATION_ICON_OPTIONS.filter((item) => (iconCategory === '全部' || item.category === iconCategory) && (!query || `${item.label} ${item.category} ${item.keywords}`.toLocaleLowerCase().includes(query)))
  }, [iconCategory, iconSearch])

  async function enter(location: LocationNode) {
    setEntering(location.id); setError('')
    try { await enterLocation(location.id); void navigate('/') }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setEntering('') }
  }

  function openEdit(location: LocationNode) {
    setSelectedId(location.id)
    setForm({ name: location.name, description: location.description, note: location.note ?? '', access: location.access, iconId: location.mapBinding?.iconId ?? location.mapBinding?.buildingCategory ?? 'custom', customIconDataUrl: location.mapBinding?.customIconDataUrl })
    setFormMode('edit'); setIconSearch(''); setIconCategory('全部'); setChildForm(undefined); setEditingChildId(undefined)
  }

  function openNewChild(location: LocationNode) {
    openEdit(location)
    setEditingChildId(undefined)
    setChildForm(EMPTY_CHILD_FORM)
  }

  function handleMarker(location: LocationNode) {
    setDraftPoint(undefined)
    setSelectedId(location.id)
  }

  function hasNearbyLocation(point: { x: number; y: number }, excludeId?: string) {
    return locations.some((item) => item.id !== excludeId && item.mapBinding && Math.max(Math.abs(item.mapBinding.x - point.x), Math.abs(item.mapBinding.y - point.y)) < 2)
  }

  async function handleMapClick(point: { x: number; y: number }) {
    if (!map) return
    if (movingId) {
      const location = locations.find((item) => item.id === movingId)
      if (!location?.mapBinding) return
      if (hasNearbyLocation(point, location.id)) { setError('距离其他地点太近，请至少间隔一格'); return }
      if (!isLocationPlacementAvailable(point, locations, map, location.id, location.mapBinding.allowedTerrains)) { setError('这个地点不能放在当前地形上'); return }
      await db.locations.update(location.id, { mapBinding: { ...location.mapBinding, x: point.x, y: point.y }, updatedAt: Date.now() })
      setMovingId(undefined); setSelectedId(location.id); return
    }
    if (hasNearbyLocation(point)) { setDraftPoint(undefined); setError('这个区域距离已有地点太近，不能放置新地点'); return }
    setError(''); setDraftPoint(point); setSelectedId(undefined)
  }

  function beginNewLocation() {
    if (!draftPoint) return
    setForm(EMPTY_FORM); setFormMode('new'); setIconSearch(''); setIconCategory('全部')
  }

  async function saveLocation() {
    if (!map || !form.name.trim()) { setError('请填写地点名称'); return }
    setError('')
    try {
      if (formMode === 'new') {
        if (!draftPoint || hasNearbyLocation(draftPoint)) { setError('这个区域距离已有地点太近，不能放置新地点'); return }
        const nowAt = Date.now(), icon = getLocationIcon(form.iconId)
        await db.locations.add({
          id: crypto.randomUUID(), name: form.name.trim(), kind: 'custom', description: form.description.trim() || '用户创建的地点。', note: form.note.trim() || undefined, access: form.access,
          mapBinding: { x: draftPoint.x, y: draftPoint.y, allowedTerrains: ALL_TERRAINS, buildingCategory: icon.id, iconId: icon.id, customIconDataUrl: form.customIconDataUrl },
          userCreated: true, sortOrder: Math.max(100, ...locations.map((item) => item.sortOrder)) + 10, createdAt: nowAt, updatedAt: nowAt,
        })
      } else if (selected?.mapBinding) {
        const icon = getLocationIcon(form.iconId)
        await db.locations.update(selected.id, { name: form.name.trim(), description: form.description.trim(), note: form.note.trim() || undefined, access: form.access, mapBinding: { ...selected.mapBinding, buildingCategory: icon.id, iconId: icon.id, customIconDataUrl: form.customIconDataUrl }, updatedAt: Date.now() })
      }
      setFormMode(undefined); setDraftPoint(undefined)
    } catch (reason) { setError(reason instanceof Error && reason.name === 'ConstraintError' ? '地点名称不能重复' : reason instanceof Error ? reason.message : String(reason)) }
  }

  async function deleteAnyLocation(location: LocationNode, label: '地点' | '子地点') {
    if (!window.confirm(`删除${label}“${location.name}”及其下属地点？此操作无法撤销。`)) return
    await deleteLocationTree(location.id)
    setSelectedId(undefined)
    setFormMode(undefined)
    setChildForm(undefined)
    setEditingChildId(undefined)
  }

  function audibilityBetween(firstId: string, secondId: string): LocationAudibility {
    return acousticEdges.find((edge) => (edge.fromLocationId === firstId && edge.toLocationId === secondId) || (edge.bidirectional && edge.fromLocationId === secondId && edge.toLocationId === firstId))?.audibility ?? 'none'
  }

  async function setAudibility(firstId: string, secondId: string, audibility: LocationAudibility) {
    const existing = acousticEdges.find((edge) => (edge.fromLocationId === firstId && edge.toLocationId === secondId) || (edge.bidirectional && edge.fromLocationId === secondId && edge.toLocationId === firstId))
    const [fromLocationId, toLocationId] = [firstId, secondId].sort()
    await db.acousticEdges.put({ id: existing?.id ?? `custom-acoustic:${fromLocationId}:${toLocationId}`, fromLocationId, toLocationId, audibility, bidirectional: true })
  }

  async function importIcon(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = ''
    if (!file) return
    if (file.size > 2 * 1024 * 1024) { setError('地点图标不能超过 2MB'); return }
    try { const customIconDataUrl = await readImage(file); setForm((value) => ({ ...value, customIconDataUrl, iconId: 'custom' })) } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }

  async function saveChild() {
    if (!selected || !childForm?.name.trim()) { setError('请填写子地点名称'); return }
    const nowAt = Date.now()
    if (editingChildId) await db.locations.update(editingChildId, { name: childForm.name.trim(), description: childForm.description.trim() || '用户创建的子地点。', access: childForm.access, updatedAt: nowAt })
    else await db.locations.add({ id: crypto.randomUUID(), parentId: selected.id, name: childForm.name.trim(), kind: 'custom-subplace', description: childForm.description.trim() || '用户创建的子地点。', access: childForm.access, userCreated: true, sortOrder: Math.max(selected.sortOrder, ...locations.map((item) => item.sortOrder)) + 1, createdAt: nowAt, updatedAt: nowAt })
    setChildForm(undefined); setEditingChildId(undefined)
  }

  async function deleteChild(child: LocationNode) {
    await deleteAnyLocation(child, '子地点')
  }

  async function regenerate() {
    if (!window.confirm('重新生成会更换地形并重新分配所有顶层地点，但会保留名称、备注、图标和子地点。确定继续？')) return
    setRegenerating(true); setError('')
    try { await regenerateLocationMap(); setSelectedId(undefined); setDraftPoint(undefined) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setRegenerating(false) }
  }

  return <div className="ui-page relative">
    <TopBar title="地点" showBack right={<button type="button" title="重新生成地图" aria-label="重新生成地图" disabled={regenerating} onClick={() => void regenerate()} className="flex h-9 w-9 items-center justify-center text-gray-700 disabled:opacity-40"><RotateCcw size={17} className={regenerating ? 'animate-spin' : ''} /></button>} />
    <main className="relative min-h-0 flex-1">{map ? <>
      <LocationMapCanvas map={map} locations={locations} activeLocationId={state?.currentLocationId} contacts={contacts} selectedLocationId={selectedId} draftPoint={draftPoint} placementMode={!!movingId} onBuildingClick={handleMarker} onMapClick={(point) => void handleMapClick(point)} onConfirmDraft={beginNewLocation} />
      <div className="pointer-events-none absolute left-3 top-3 z-10 max-w-[calc(100%-76px)] rounded-[var(--ui-radius-card)] border border-[var(--ui-border)] bg-[var(--ui-surface)] px-3 py-2 shadow-[var(--ui-shadow)]"><p className="truncate text-xs font-medium text-[var(--ui-text)]">{active ? `当前在 ${active.name}` : '选择一个地点进入'}</p><p className="mt-0.5 text-[10px] text-[var(--ui-text-3)]">{timeText} · {realSeason(now)}</p></div>
      {active && <button type="button" onClick={() => navigate('/chat/talk-location-conversation')} className="absolute bottom-5 left-4 z-20 rounded-[var(--ui-radius-control)] bg-[var(--ui-action)] px-3 py-2 text-xs font-medium text-[var(--ui-on-action)] shadow-[var(--ui-shadow)]">回到地点群聊</button>}
      {!movingId && !draftPoint && <div className="pointer-events-none absolute inset-x-14 bottom-5 z-10 rounded-[var(--ui-radius-control)] bg-[var(--ui-surface)] px-4 py-2 text-center text-xs text-[var(--ui-text-2)] shadow-[var(--ui-shadow)]">点空白格显示＋，地点周围一格内不可放置</div>}
    </> : <div className="flex h-full items-center justify-center text-sm text-gray-400">地图加载中…</div>}
    {error && <button type="button" onClick={() => setError('')} className="absolute inset-x-3 top-16 z-50 rounded-xl bg-red-50 px-3 py-2 text-left text-xs text-red-600 shadow">{error}</button>}
    </main>

    {selected && <div className="absolute inset-x-0 bottom-0 z-30 max-h-[68%] overflow-y-auto rounded-t-[var(--ui-radius-card)] bg-[var(--ui-surface)] p-4 pb-[calc(env(safe-area-inset-bottom)+16px)] shadow-[var(--ui-shadow)]">
      <div className="flex items-start justify-between"><div><h2 className="font-semibold text-gray-900">{selected.name}</h2><p className="mt-0.5 text-xs text-gray-400">{selected.description}</p>{selected.note && <p className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">备注：{selected.note}</p>}</div><div className="flex items-center gap-1"><button type="button" onClick={() => openEdit(selected)} className="rounded-lg px-2 py-1 text-xs text-gray-600">编辑</button><button type="button" onClick={() => void deleteAnyLocation(selected, '地点')} className="rounded-lg px-2 py-1 text-xs text-red-500">删除地点</button><button type="button" onClick={() => setSelectedId(undefined)} className="flex h-8 w-8 items-center justify-center text-gray-400"><X size={20} /></button></div></div>
      <section className="mt-3 rounded-2xl bg-gray-50 p-3"><p className="text-xs font-medium text-gray-700">当前在这里 · {selectedPeople.length}人</p>{selectedPeople.length ? <div className="mt-2 flex flex-wrap gap-3">{selectedPeople.map((contact) => <span key={contact.id} className="flex items-center gap-1.5 text-xs text-gray-600"><Avatar avatar={contact.avatar} color={contact.avatarColor} size={26} />{contact.remark || contact.name}</span>)}</div> : <p className="mt-1 text-[11px] text-gray-400">当前无人</p>}</section>
      <div className="mt-3 grid auto-rows-fr grid-cols-2 gap-2">{(children.length ? children : [selected]).map((location) => {
        const people = contacts.filter((contact) => contact.currentLocationId === location.id)
        return <div key={location.id} className="relative h-full"><button type="button" disabled={!!entering} onClick={() => void enter(location)} className={`h-full w-full rounded-xl border px-3 py-3 pr-10 text-left text-sm disabled:opacity-50 ${state?.currentLocationId === location.id ? 'border-[var(--ui-special)] bg-[var(--ui-special-soft)] text-[var(--ui-special-ink)]' : 'border-gray-200 text-gray-700'}`}><span className="flex items-center justify-between gap-2"><span className="truncate">{location.name}</span>{people.length > 0 && <b className="shrink-0 text-xs">{people.length}人</b>}</span><span className="mt-1 block truncate text-[10px] text-gray-400">{entering === location.id ? '正在进入…' : location.description}</span></button>{location.id !== selected.id && <button type="button" onClick={() => void deleteAnyLocation(location, '子地点')} className="absolute right-2 top-2 rounded px-1.5 py-1 text-[10px] text-red-500">删除</button>}</div>
      })}{selected.mapBinding && <button type="button" onClick={() => openNewChild(selected)} className="flex h-full min-h-[76px] items-center justify-center rounded-xl border-2 border-dashed border-gray-300 text-gray-400 active:border-[var(--ui-special)] active:text-[var(--ui-special-ink)]" aria-label="新建子地点"><Plus size={26} /></button>}</div>
    </div>}

    {formMode && <div onPointerDown={(event) => event.stopPropagation()} onPointerUp={(event) => event.stopPropagation()} onTouchStart={(event) => event.stopPropagation()} className="pointer-events-auto absolute inset-x-0 bottom-0 z-50 max-h-[82%] touch-auto overflow-y-auto rounded-t-3xl bg-white p-4 pb-[calc(env(safe-area-inset-bottom)+16px)] shadow-2xl">
      <div className="flex items-center justify-between"><h2 className="font-semibold text-gray-900">{formMode === 'new' ? '新增地点' : '编辑地点'}</h2><button type="button" aria-label="关闭地点表单" onClick={() => { setFormMode(undefined); setDraftPoint(undefined); setChildForm(undefined) }}><X size={20} /></button></div>
      <label className="mt-4 block text-xs text-gray-500">地点名称<input type="text" inputMode="text" autoComplete="off" autoFocus value={form.name} onChange={(event) => setForm((value) => ({ ...value, name: event.target.value }))} className="mt-1 w-full rounded-xl border border-[var(--ui-border)] bg-[var(--ui-surface-2)] px-3 py-2.5 text-sm text-[var(--ui-text)]" placeholder="例如：星河公寓" /></label>
      <label className="mt-3 block text-xs text-gray-500">地点描述<textarea value={form.description} onChange={(event) => setForm((value) => ({ ...value, description: event.target.value }))} className="mt-1 h-16 w-full resize-none rounded-xl border border-[var(--ui-border)] bg-[var(--ui-surface-2)] px-3 py-2 text-sm text-[var(--ui-text)]" placeholder="简单描述这个地点" /></label>
      <label className="mt-3 block text-xs text-gray-500">个人备注<textarea value={form.note} onChange={(event) => setForm((value) => ({ ...value, note: event.target.value }))} className="mt-1 h-16 w-full resize-none rounded-xl border border-[var(--ui-border)] bg-[var(--ui-surface-2)] px-3 py-2 text-sm text-[var(--ui-text)]" placeholder="记录这个地点的设定、用途或注意事项" /></label>
      <div className="mt-3"><label className="text-xs text-gray-500">地点图标</label><input type="search" inputMode="search" value={iconSearch} onChange={(event) => setIconSearch(event.target.value)} className="mt-1 w-full rounded-xl border border-[var(--ui-border)] bg-[var(--ui-surface-2)] px-3 py-2 text-sm text-[var(--ui-text)]" placeholder="搜索公寓、医院、公园……" /><div className="mt-2 flex gap-1.5 overflow-x-auto pb-1">{LOCATION_ICON_CATEGORIES.map((category) => <button key={category} type="button" onClick={() => setIconCategory(category)} className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] ${iconCategory === category ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'}`}>{category}</button>)}</div><div className="mt-2 grid max-h-40 grid-cols-5 gap-2 overflow-y-auto">{filteredIcons.map((icon) => <button key={icon.id} type="button" onClick={() => setForm((value) => ({ ...value, iconId: icon.id, customIconDataUrl: undefined }))} className={`flex min-h-14 flex-col items-center justify-center rounded-xl border text-2xl ${form.iconId === icon.id && !form.customIconDataUrl ? 'border-[var(--ui-special)] bg-[var(--ui-special-soft)]' : 'border-gray-100'}`} title={`${icon.category} · ${icon.label}`}>{icon.glyph}<small className="mt-0.5 max-w-full truncate px-1 text-[8px] text-gray-500">{icon.label}</small></button>)}</div><label className="mt-2 flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-gray-300 py-2 text-xs text-gray-600"><Upload size={14} />上传自定义图标<input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => void importIcon(event)} /></label>{form.customIconDataUrl && <div className="mt-2 flex items-center gap-2 text-xs text-gray-500"><img src={form.customIconDataUrl} alt="自定义图标预览" className="h-10 w-10 rounded-lg object-contain" />已选择自定义图标</div>}</div>
      <label className="mt-3 block text-xs text-gray-500">访问权限<select value={form.access} onChange={(event) => setForm((value) => ({ ...value, access: event.target.value as LocationNode['access'] }))} className="mt-1 w-full rounded-xl border border-[var(--ui-border)] bg-[var(--ui-surface-2)] px-3 py-2.5 text-sm text-[var(--ui-text)]"><option value="public">公开</option><option value="restricted">受限</option><option value="private">私人</option></select></label>

      {formMode === 'edit' && selected && <section className="mt-4 rounded-2xl bg-gray-50 p-3"><div className="flex items-center justify-between"><div><h3 className="text-xs font-semibold text-gray-800">子地点</h3><p className="mt-0.5 text-[10px] text-gray-400">子地点不会额外占用地图格子</p></div><button type="button" aria-label="添加子地点" onClick={() => { setEditingChildId(undefined); setChildForm(EMPTY_CHILD_FORM) }} className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-gray-700 shadow"><Plus size={16} /></button></div>
        {children.length > 0 && <div className="mt-2 space-y-1.5">{children.map((child) => <div key={child.id} className="flex items-center justify-between rounded-xl bg-white px-3 py-2"><div className="min-w-0"><p className="truncate text-xs text-gray-700">{child.name}</p><p className="truncate text-[9px] text-gray-400">{child.description}</p></div><button type="button" onClick={() => { setEditingChildId(child.id); setChildForm({ name: child.name, description: child.description, access: child.access }) }} className="ml-2 shrink-0 text-[10px] text-gray-500">编辑</button></div>)}</div>}
        {childForm && <div className="mt-3 rounded-xl border border-gray-200 bg-white p-3"><input value={childForm.name} onChange={(event) => setChildForm((value) => value ? { ...value, name: event.target.value } : value)} className="w-full rounded-lg border px-2.5 py-2 text-xs" placeholder="子地点名称" /><textarea value={childForm.description} onChange={(event) => setChildForm((value) => value ? { ...value, description: event.target.value } : value)} className="mt-2 h-14 w-full resize-none rounded-lg border px-2.5 py-2 text-xs" placeholder="子地点描述" /><div className="mt-2 flex gap-2"><button type="button" onClick={() => { setChildForm(undefined); setEditingChildId(undefined) }} className="flex-1 rounded-lg border py-2 text-xs text-gray-500">取消</button><button type="button" onClick={() => void saveChild()} className="flex-1 rounded-lg bg-gray-900 py-2 text-xs text-white">保存子地点</button></div>{editingChildId && locations.find((item) => item.id === editingChildId)?.userCreated && <button type="button" onClick={() => { const child = locations.find((item) => item.id === editingChildId); if (child) void deleteChild(child); setChildForm(undefined); setEditingChildId(undefined) }} className="mt-2 w-full py-1 text-[10px] text-red-500">删除这个子地点</button>}</div>}
      </section>}

      <div className="mt-4 flex gap-2">{formMode === 'edit' && selected?.mapBinding && <button type="button" onClick={() => { setMovingId(selected.id); setFormMode(undefined); setDraftPoint(undefined) }} className="flex items-center justify-center gap-1 rounded-xl border border-gray-200 px-3 py-2.5 text-xs text-gray-700"><MapPinned size={15} />重新定位</button>}<button type="button" onClick={() => void saveLocation()} className="flex-1 rounded-xl bg-gray-900 py-2.5 text-sm text-white">保存</button></div>
      {formMode === 'edit' && selected && <section className="mt-4 rounded-2xl bg-gray-50 p-3"><div className="flex items-center justify-between"><div><h3 className="text-xs font-semibold text-gray-800">子地点声学</h3><p className="mt-0.5 text-[10px] text-gray-400">设置同一地点内子地点之间的听觉关系。</p></div><button type="button" onClick={() => openNewChild(selected)} className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-gray-700 shadow" aria-label="新建子地点"><Plus size={16} /></button></div>{children.length < 2 ? <p className="mt-3 text-xs text-gray-400">至少创建两个子地点后可设置。</p> : <div className="mt-3 space-y-2">{children.flatMap((first, index) => children.slice(index + 1).map((second) => { const value = audibilityBetween(first.id, second.id); return <div key={`${first.id}:${second.id}`} className="rounded-xl bg-white p-2.5"><p className="truncate text-xs text-gray-700">{first.name} <span className="text-gray-300">↔</span> {second.name}</p><div className="mt-2 grid grid-cols-3 gap-1">{([['clear', '清晰'], ['muffled', '模糊'], ['none', '听不见']] as Array<[LocationAudibility, string]>).map(([next, label]) => <button type="button" key={next} onClick={() => void setAudibility(first.id, second.id, next)} className={`rounded-lg py-1.5 text-[10px] ${value === next ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-500'}`}>{label}</button>)}</div></div> }))}</div>}<div className="mt-3 space-y-1.5 border-t border-gray-200 pt-3">{children.map((child) => <div key={child.id} className="flex items-center justify-between rounded-lg bg-white px-2.5 py-2"><span className="min-w-0 truncate text-xs text-gray-600">{child.name}</span><button type="button" onClick={() => void deleteAnyLocation(child, '子地点')} className="ml-2 shrink-0 text-[10px] text-red-500">删除</button></div>)}</div><button type="button" onClick={() => void deleteAnyLocation(selected, '地点')} className="mt-3 w-full py-2 text-xs text-red-500">删除这个地点</button></section>}
    </div>}
  </div>
}
