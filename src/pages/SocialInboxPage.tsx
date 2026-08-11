import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate } from 'react-router-dom'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { useSettingsStore } from '../store/useSettingsStore'
import { UiIcon } from '../components/UiIcon'

export function SocialInboxPage() {
  const navigate = useNavigate()
  const lastReadAt = useSettingsStore((s) => s.momentsLastReadAt ?? 0)
  const events = useLiveQuery(() => db.socialEvents.orderBy('createdAt').reverse().limit(80).toArray(), []) ?? []
  const items = events.filter((event) => event.targetId === 'user' || event.actorId !== 'user').slice(0, 40)
  const style = (type: string) => type.includes('liked') ? ['❤️', 'bg-pink-50 text-pink-600'] : type.includes('commented') ? ['💬', 'bg-blue-50 text-blue-600'] : type.includes('plan') ? ['📅', 'bg-amber-50 text-amber-700'] : type === 'group_turn' ? ['👥', 'bg-[var(--ui-special-soft)] text-[var(--ui-special-ink)]'] : ['✨', 'bg-green-50 text-green-600']
  return <div className="ui-page"><TopBar title="互动收件箱" showBack /><div className="ui-page-scroll"><section className="ui-page-intro"><p className="ui-page-kicker">社交动态</p><h1 className="ui-page-title">最近收到的互动</h1><p className="ui-page-summary">点赞、评论和人物之间的公开互动会集中出现在这里。</p></section>{items.length === 0 ? <div className="ui-empty-state">还没有新的互动。</div> : <div className="space-y-2 px-3 pt-3">{items.map((event) => { const [icon, color] = style(event.type); return <button key={event.id} type="button" onClick={() => event.momentId ? navigate(`/moments?focus=${event.momentId}`) : event.groupId ? navigate(`/group/${event.groupId}`) : event.conversationId ? navigate(`/chat/${event.conversationId}`) : undefined} className={`flex w-full gap-3 rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] p-3 text-left shadow-[var(--ui-shadow)] ${event.createdAt > lastReadAt ? 'ring-1 ring-[var(--ui-success)]' : ''}`}><span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${color}`}><UiIcon name={icon} size={18} /></span><span><p className="text-sm text-[var(--ui-text)]">{event.summary}</p><p className="mt-1 text-[11px] text-[var(--ui-text-3)]">{new Date(event.createdAt).toLocaleString()}</p></span></button> })}</div>}</div></div>
}
