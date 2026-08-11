import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate } from 'react-router-dom'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { Avatar } from '../components/Avatar'
import { displayName } from '../lib/contact'
import { warmthLabel } from '../lib/relationship'
import { uniqueRelationPairs } from '../lib/contactRelations'
import type { Contact } from '../types'
import { isAiTestId } from '../lib/aiTestIsolation'

const EMPTY_ARRAY: never[] = []

export function RelationshipsPage() {
  const navigate = useNavigate()
  const contactsRaw = useLiveQuery(() => db.contacts.toArray(), []) ?? EMPTY_ARRAY
  const relationRows = useLiveQuery(() => db.contactRelations.toArray(), []) ?? EMPTY_ARRAY
  const relations = useMemo(() => uniqueRelationPairs(relationRows), [relationRows])
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const contacts = useMemo(
    () => contactsRaw.filter((contact) => !isAiTestId(contact.id)).sort((a, b) => (b.warmth ?? 0) - (a.warmth ?? 0)),
    [contactsRaw],
  )
  const contactById = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts])

  return (
    <div className="ui-page">
      <TopBar title="好感度" showBack />
      <div className="ui-page-scroll">

      <section className="ui-page-intro"><p className="ui-page-kicker">与你的好感度</p><h1 className="ui-page-title">{contacts.length} 位联系人的好感度</h1><p className="ui-page-summary">从高到低查看每位联系人对你的好感阶段；展开后可继续查看基础关系与人物连接。</p></section>

      {contacts.length === 0 ? (
        <div className="ui-empty-state">还没有联系人，建立人物后好感度会在这里逐渐变化。</div>
      ) : (
        <div className="mt-1 flex-1 space-y-2 px-4 pb-4">
          {contacts.map((c) => (
            <RelationshipCard
              key={c.id}
              contact={c}
              expanded={expandedId === c.id}
              onToggle={() => setExpandedId(expandedId === c.id ? null : c.id)}
              onOpenCard={() => navigate(`/contact/${c.id}`)}
              links={relations
                .filter((r) => r.fromContactId === c.id || r.toContactId === c.id)
                .map((r) => ({
                  label: r.label,
                  other: contactById.get(r.fromContactId === c.id ? r.toContactId : r.fromContactId),
                }))
                .filter((l) => l.other)}
            />
          ))}
        </div>
      )}
      </div>
    </div>
  )
}

function RelationshipCard({
  contact: c,
  expanded,
  onToggle,
  onOpenCard,
  links,
}: {
  contact: Contact
  expanded: boolean
  onToggle: () => void
  onOpenCard: () => void
  links: { label: string; other: Contact | undefined }[]
}) {
  const warmth = c.warmth ?? 0
  const stageLabel = warmthLabel(warmth)
  // Bar: 0 = leftmost (-100 warmth), 100% = rightmost (+100 warmth)
  const barPercent = Math.round(((warmth + 100) / 200) * 100)

  return (
    <div className="rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] p-3 shadow-[var(--ui-shadow)]">
      <button onClick={onToggle} className="flex w-full items-center gap-3 text-left">
        <Avatar avatar={c.avatar} color={c.avatarColor} size={40} />
        <div className="min-w-0 flex-1">
          <p className="ui-font-display truncate text-[15px] font-medium text-gray-900">{displayName(c)}</p>
          <p className="text-xs text-gray-400">{c.relationshipBase || '朋友'}{c.relationshipDynamic ? ` · ${c.relationshipDynamic}` : ''}</p>
        </div>
        <span className="shrink-0 rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-600">
          {stageLabel}
        </span>
      </button>

      {/* Single warmth bar: gradient from red (cold) through gray (neutral) to green (warm) */}
      <div className="mt-2 mb-1 flex items-center gap-2">
        <span className="text-[10px] text-gray-400">-100</span>
        <div data-ui-scope="special" className="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden">
          <div
            className="h-full rounded-full transition-all"
            style={{
              width: `${barPercent}%`,
              background: warmth >= 0
                ? `linear-gradient(to right, #9ca3af, #4ade80)`
                : `linear-gradient(to right, #ef4444, #9ca3af)`,
            }}
          />
        </div>
        <span className="text-[10px] text-gray-400">+100</span>
      </div>
      <p className="text-center text-[11px] text-gray-500">好感度: {warmth} · {stageLabel}</p>

      {expanded && (
        <div className="mt-3 space-y-1.5 border-t border-gray-100 pt-3">
          <div className="flex justify-between text-xs text-gray-500">
            <span>基础关系</span>
            <span>{c.relationshipBase || '朋友'}</span>
          </div>
          {c.relationshipDynamic && (
            <div className="flex justify-between text-xs text-gray-500">
              <span>当前状态</span>
              <span>{c.relationshipDynamic}</span>
            </div>
          )}

          <div className="border-t border-gray-100 pt-2">
            <p className="mb-1 text-xs font-medium text-gray-400">TA与其他人的关系</p>
            {links.length === 0 ? (
              <p className="text-xs text-gray-400">还没有设置和其他联系人的关系</p>
            ) : (
              <div className="space-y-1">
                {links.map((l, i) => (
                  <p key={i} className="text-xs text-gray-500">
                    {l.other ? displayName(l.other) : '未知'} · {l.label}
                  </p>
                ))}
              </div>
            )}
          </div>

          <button onClick={onOpenCard} className="mt-2 w-full rounded-lg bg-gray-100 py-2 text-xs text-gray-700">
            查看联系人名片
          </button>
        </div>
      )}
    </div>
  )
}
