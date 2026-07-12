import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate } from 'react-router-dom'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { useSettingsStore } from '../store/useSettingsStore'

export function SocialInboxPage() {
  const navigate = useNavigate()
  const lastReadAt = useSettingsStore((s) => s.momentsLastReadAt ?? 0)
  const events = useLiveQuery(() => db.socialEvents.orderBy('createdAt').reverse().limit(80).toArray(), []) ?? []
  const items = events.filter((event) => event.targetId === 'user' || event.actorId !== 'user').slice(0, 40)
  const style = (type: string) => type.includes('liked') ? ['❤️', 'bg-pink-50 text-pink-600'] : type.includes('commented') ? ['💬', 'bg-blue-50 text-blue-600'] : type.includes('plan') ? ['📅', 'bg-amber-50 text-amber-700'] : type === 'group_turn' ? ['👥', 'bg-purple-50 text-purple-600'] : ['✨', 'bg-green-50 text-green-600']
  return <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]"><TopBar title="互动收件箱" showBack /><div className="flex-1 overflow-y-auto p-3">{items.length === 0 ? <p className="py-10 text-center text-sm text-gray-400">还没有新的互动。</p> : <div className="space-y-2">{items.map((event) => { const [icon, color] = style(event.type); return <button key={event.id} type="button" onClick={() => event.momentId ? navigate(`/moments?focus=${event.momentId}`) : event.groupId ? navigate(`/group/${event.groupId}`) : event.conversationId ? navigate(`/chat/${event.conversationId}`) : undefined} className={`flex w-full gap-3 rounded-xl bg-white p-3 text-left ${event.createdAt > lastReadAt ? 'ring-1 ring-[#07c160]/30' : ''}`}><span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${color}`}>{icon}</span><span><p className="text-sm text-gray-800">{event.summary}</p><p className="mt-1 text-[11px] text-gray-400">{new Date(event.createdAt).toLocaleString()}</p></span></button> })}</div>}</div></div>
}
