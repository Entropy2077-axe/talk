import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Clock3, MapPin, Navigation, Users, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Avatar } from '../components/Avatar'
import { TopBar } from '../components/TopBar'
import { db } from '../db/db'
import { displayName } from '../lib/contact'
import { getLocationIcon } from '../lib/locationIcons'
import {
  ensureSlgPlayerLocation,
  enterSlgLocation,
  isLeafLocation,
  locationTreeIds,
  realSeason,
  slgConversationId,
  syncContactLocationsAt,
} from '../lib/locations'
import { useSettingsStore } from '../store/useSettingsStore'
import type { Contact, LocationNode } from '../types'

const EMPTY_LOCATIONS: LocationNode[] = []
const EMPTY_CONTACTS: Contact[] = []
const BOARD_WIDTH = 760
const BOARD_HEIGHT = 590

function rootFor(locationId: string | undefined, byId: Map<string, LocationNode>) {
  let current = locationId ? byId.get(locationId) : undefined
  while (current?.parentId && current.parentId !== 'city') current = byId.get(current.parentId)
  return current
}

function concreteChildren(root: LocationNode, locations: LocationNode[]) {
  if (isLeafLocation(root.id, locations)) return [root]
  const tree = locationTreeIds(root.id, locations)
  return locations
    .filter((location) => tree.has(location.id) && isLeafLocation(location.id, locations))
    .sort((a, b) => a.sortOrder - b.sortOrder)
}

function timeLabel(date: Date) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(date)
}

export function SlgLocationsPage() {
  const navigate = useNavigate()
  const [selectedRootId, setSelectedRootId] = useState<string>()
  const [movingTo, setMovingTo] = useState('')
  const [error, setError] = useState('')
  const [now, setNow] = useState(() => new Date())
  const userAvatar = useSettingsStore((state) => state.userAvatar)
  const locations = useLiveQuery(() => db.locations.orderBy('sortOrder').toArray(), []) ?? EMPTY_LOCATIONS
  const contacts = useLiveQuery(() => db.contacts.toArray(), []) ?? EMPTY_CONTACTS
  const state = useLiveQuery(() => db.locationModuleState.get('active'), [])

  useEffect(() => {
    let cancelled = false
    const sync = async () => {
      try {
        await ensureSlgPlayerLocation()
        await syncContactLocationsAt(new Date())
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      }
    }
    void sync()
    const timer = window.setInterval(() => { setNow(new Date()); void sync() }, 60_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [])

  const byId = useMemo(() => new Map(locations.map((location) => [location.id, location])), [locations])
  const roots = useMemo(() => locations.filter((location) => !!location.mapBinding).sort((a, b) => a.sortOrder - b.sortOrder), [locations])
  const selectedRoot = selectedRootId ? byId.get(selectedRootId) : undefined
  const currentLeaf = state?.slgCurrentLocationId ? byId.get(state.slgCurrentLocationId) : undefined
  const currentRoot = rootFor(state?.slgCurrentLocationId, byId)
  const rootPeople = useMemo(() => {
    const result = new Map<string, Contact[]>()
    for (const contact of contacts) {
      const root = rootFor(contact.currentLocationId, byId)
      if (root) result.set(root.id, [...(result.get(root.id) ?? []), contact])
    }
    return result
  }, [byId, contacts])
  const selectedLeaves = useMemo(() => selectedRoot ? concreteChildren(selectedRoot, locations) : [], [locations, selectedRoot])
  const activePeople = currentLeaf ? contacts.filter((contact) => contact.currentLocationId === currentLeaf.id) : []

  async function move(location: LocationNode) {
    setMovingTo(location.id); setError('')
    try {
      const conversationId = await enterSlgLocation(location.id)
      setSelectedRootId(undefined)
      void navigate(`/chat/${conversationId}`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setMovingTo('')
    }
  }

  async function returnToScene() {
    if (!currentLeaf) return
    const conversation = await db.conversations.get(slgConversationId(currentLeaf.id))
    if (conversation) void navigate(`/chat/${conversation.id}`)
    else void move(currentLeaf)
  }

  return (
    <div className="relative flex h-[var(--app-height)] flex-col overflow-hidden bg-[#e8eee9]">
      <TopBar title="临江市 · 虚拟人生" showBack />
      <div className="border-b border-black/5 bg-[#f7faf7] px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-medium tracking-[.14em] text-[#587063]">WORLD LIVE</p>
            <p className="mt-1 truncate text-sm font-semibold text-[#24382e]">你在 {currentLeaf?.name ?? '定位中…'}</p>
            <p className="mt-0.5 text-[11px] text-[#718078]">{timeLabel(now)} · {realSeason(now)}</p>
          </div>
          <button type="button" disabled={!currentLeaf} onClick={() => void returnToScene()} className="shrink-0 rounded-xl bg-[#315c4a] px-3 py-2 text-xs font-medium text-white disabled:opacity-40">
            当前现场
          </button>
        </div>
        <div className="mt-3 flex gap-2 overflow-x-auto pb-0.5">
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-white px-2.5 py-1 text-[10px] text-[#52665b]"><Users size={12} />{contacts.length} 位居民</span>
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-white px-2.5 py-1 text-[10px] text-[#52665b]"><MapPin size={12} />{roots.length} 个区域</span>
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-white px-2.5 py-1 text-[10px] text-[#52665b]"><Clock3 size={12} />按现实时间运行</span>
        </div>
      </div>

      <main className="relative min-h-0 flex-1 overflow-auto overscroll-none">
        <div className="relative m-3 overflow-hidden rounded-3xl border border-white/80 bg-[#dce8df] shadow-[0_16px_50px_rgba(44,72,56,.12)]" style={{ width: BOARD_WIDTH, height: BOARD_HEIGHT }}>
          <div className="absolute inset-0 opacity-35" style={{ backgroundImage: 'linear-gradient(rgba(49,92,74,.10) 1px,transparent 1px),linear-gradient(90deg,rgba(49,92,74,.10) 1px,transparent 1px)', backgroundSize: '40px 40px' }} />
          <div className="absolute -left-16 top-16 h-24 w-[900px] -rotate-6 rounded-[50%] border-[18px] border-[#b9d6dd]/70" />
          <div className="absolute bottom-6 right-10 h-40 w-56 rounded-[45%] bg-[#c8ddc5]/75 blur-[2px]" />
          {[80, 185, 290, 395, 500].map((top) => <span key={`road-y-${top}`} className="absolute left-10 right-10 h-1 rounded-full bg-white/60 shadow-[0_1px_0_rgba(49,92,74,.08)]" style={{ top }} />)}
          {[80, 225, 370, 515, 660].map((left) => <span key={`road-x-${left}`} className="absolute bottom-10 top-10 w-1 rounded-full bg-white/45" style={{ left }} />)}
          {roots.map((location) => {
            const binding = location.mapBinding!
            const index = roots.indexOf(location)
            const x = 80 + (index % 5) * 145
            const y = 72 + Math.floor(index / 5) * 105
            const people = rootPeople.get(location.id) ?? []
            const current = currentRoot?.id === location.id
            const icon = getLocationIcon(binding.iconId ?? binding.buildingCategory)
            return (
              <button key={location.id} type="button" onClick={() => setSelectedRootId(location.id)} className="absolute z-10 -translate-x-1/2 -translate-y-1/2 text-left" style={{ left: x, top: y }} aria-label={`查看${location.name}`}>
                <span className={`relative flex h-14 w-14 items-center justify-center rounded-2xl border-2 text-2xl shadow-lg ${current ? 'border-[#315c4a] bg-[#fffdf4] ring-4 ring-[#315c4a]/15' : 'border-white bg-white/95'}`}>
                  {icon.glyph}
                  {people.length > 0 && <b className="absolute -right-2 -top-2 flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-white bg-[#d96b4c] px-1 text-[9px] text-white">{people.length}</b>}
                  {current && <span className="absolute -bottom-3 -left-3 rounded-full border-2 border-white bg-[#e3f0e7]"><Avatar avatar={userAvatar} size={24} /></span>}
                </span>
                <span className="mt-1.5 block max-w-24 rounded-lg bg-[#24382e]/90 px-2 py-1 text-center text-[10px] font-medium text-white shadow">{location.name}</span>
              </button>
            )
          })}
          <div className="absolute bottom-3 left-4 rounded-full bg-white/85 px-3 py-1.5 text-[10px] text-[#60736a] shadow">拖动画布查看城市 · 点击区域下达行动</div>
        </div>
      </main>

      {error && <button type="button" onClick={() => setError('')} className="absolute inset-x-4 top-32 z-50 rounded-xl bg-red-50 px-3 py-2 text-left text-xs text-red-600 shadow">{error}</button>}

      {selectedRoot && <div className="absolute inset-0 z-40 flex items-end bg-black/25" onClick={() => setSelectedRootId(undefined)}>
        <section className="max-h-[76%] w-full overflow-y-auto rounded-t-3xl bg-[#f8faf8] p-4 pb-[calc(16px+env(safe-area-inset-bottom))] shadow-2xl" onClick={(event) => event.stopPropagation()}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-medium tracking-[.12em] text-[#668073]">区域情报</p>
              <h2 className="mt-1 text-xl font-semibold text-[#24382e]">{selectedRoot.name}</h2>
              <p className="mt-1 text-xs leading-relaxed text-[#708078]">{selectedRoot.description}</p>
            </div>
            <button type="button" onClick={() => setSelectedRootId(undefined)} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-gray-500"><X size={18} /></button>
          </div>

          {(rootPeople.get(selectedRoot.id) ?? []).length > 0 ? <div className="mt-4 rounded-2xl bg-white p-3">
            <p className="text-xs font-medium text-[#40574b]">当前居民</p>
            <div className="mt-2 space-y-2">{(rootPeople.get(selectedRoot.id) ?? []).map((contact) => <div key={contact.id} className="flex items-center gap-2">
              <Avatar avatar={contact.avatar} color={contact.avatarColor} size={30} />
              <div className="min-w-0 flex-1"><p className="truncate text-xs font-medium text-gray-800">{displayName(contact)}</p><p className="truncate text-[10px] text-gray-400">{byId.get(contact.currentLocationId ?? '')?.name ?? '位置未知'} · {contact.currentActivity ?? '自由活动'}</p></div>
            </div>)}</div>
          </div> : <p className="mt-4 rounded-2xl bg-white px-3 py-3 text-xs text-gray-400">当前没有已知联系人在这个区域。</p>}

          <p className="mb-2 mt-4 text-xs font-medium text-[#40574b]">选择具体地点</p>
          <div className="space-y-2">{selectedLeaves.map((leaf) => {
            const people = contacts.filter((contact) => contact.currentLocationId === leaf.id)
            const current = currentLeaf?.id === leaf.id
            return <button key={leaf.id} type="button" disabled={!!movingTo} onClick={() => void move(leaf)} className={`flex w-full items-center gap-3 rounded-2xl border px-3 py-3 text-left disabled:opacity-50 ${current ? 'border-[#315c4a] bg-[#e8f2eb]' : 'border-black/5 bg-white'}`}>
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#eef3ef] text-lg">{current ? '◎' : '•'}</span>
              <span className="min-w-0 flex-1"><span className="block text-sm font-medium text-gray-800">{leaf.name}</span><span className="mt-0.5 block truncate text-[10px] text-gray-400">{people.length ? `${people.map(displayName).join('、')}在这里` : '当前无人'}</span></span>
              <span className="flex items-center gap-1 text-[11px] font-medium text-[#315c4a]"><Navigation size={13} />{movingTo === leaf.id ? '前往中' : current ? '进入现场' : '前往'}</span>
            </button>
          })}</div>
        </section>
      </div>}

      {currentLeaf && activePeople.length > 0 && <div className="pointer-events-none absolute bottom-3 left-3 z-20 flex max-w-[70%] items-center gap-2 rounded-2xl bg-[#24382e]/92 px-3 py-2 text-white shadow-xl">
        <div className="flex -space-x-1">{activePeople.slice(0, 3).map((contact) => <Avatar key={contact.id} avatar={contact.avatar} color={contact.avatarColor} size={22} />)}</div>
        <p className="truncate text-[10px]">{activePeople.map(displayName).join('、')}与你同处{currentLeaf.name}</p>
      </div>}
    </div>
  )
}
