import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate } from 'react-router-dom'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { Avatar } from '../components/Avatar'
import { displayName } from '../lib/contact'
import { RELATIONSHIP_DIMENSIONS, dimensionQualifier, relationshipStageLabel } from '../lib/relationship'
import type { Contact, RelationshipDimensions } from '../types'

const SORT_OPTIONS: { key: keyof RelationshipDimensions; label: string }[] = [
  { key: 'affection', label: '好感度' },
  { key: 'familiarity', label: '熟悉度' },
  { key: 'romance', label: '暧昧度' },
  { key: 'friction', label: '摩擦感' },
]

const EMPTY_ARRAY: never[] = []

export function RelationshipsPage() {
  const navigate = useNavigate()
  const contactsRaw = useLiveQuery(() => db.contacts.toArray(), []) ?? EMPTY_ARRAY
  const relations = useLiveQuery(() => db.contactRelations.toArray(), []) ?? EMPTY_ARRAY
  const [sortKey, setSortKey] = useState<keyof RelationshipDimensions>('affection')
  const [showLegend, setShowLegend] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const contacts = useMemo(
    () => [...contactsRaw].sort((a, b) => b.relationship[sortKey] - a.relationship[sortKey]),
    [contactsRaw, sortKey],
  )
  const contactById = useMemo(() => new Map(contactsRaw.map((c) => [c.id, c])), [contactsRaw])

  return (
    <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
      <TopBar
        title="关系网"
        showBack
        right={
          <button
            onClick={() => setShowLegend((v) => !v)}
            aria-label="维度说明"
            className="flex h-9 w-9 items-center justify-center text-gray-500"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
              <path d="M12 11v5M12 8v.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        }
      />
      <div className="flex-1 overflow-y-auto">

      <p className="px-4 pt-3 pb-1 text-xs text-gray-400">
        跟据聊天内容自动评估 只影响语气不会改变TA的性格
      </p>

      {showLegend && (
        <div className="mx-4 mb-2 rounded-xl bg-white p-3">
          {RELATIONSHIP_DIMENSIONS.map(({ key, label, description }) => (
            <p key={key} className="py-1 text-xs text-gray-500">
              <span className="font-medium text-gray-700">{label}</span> — {description}
            </p>
          ))}
        </div>
      )}

      <div className="flex gap-2 overflow-x-auto px-4 pb-2">
        {SORT_OPTIONS.map((opt) => (
          <button
            key={opt.key}
            onClick={() => setSortKey(opt.key)}
            className={`shrink-0 rounded-full px-3 py-1.5 text-xs ${
              sortKey === opt.key ? 'bg-gray-900 text-white' : 'bg-white text-gray-500'
            }`}
          >
            按{opt.label}排序
          </button>
        ))}
      </div>

      {contacts.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-gray-400">还没有联系人</p>
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
  return (
    <div className="rounded-xl bg-white p-3">
      <button onClick={onToggle} className="flex w-full items-center gap-3 text-left">
        <Avatar avatar={c.avatar} color={c.avatarColor} size={40} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-medium text-gray-900">{displayName(c)}</p>
        </div>
        <span className="shrink-0 rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-600">
          {relationshipStageLabel(c.relationship)}
        </span>
      </button>

      <div className="mt-2 grid grid-cols-5 gap-2">
        {RELATIONSHIP_DIMENSIONS.map(({ key, label }) => (
          <div key={key} className="text-center">
            <div className="mx-auto mb-1 flex h-10 w-2 flex-col justify-end overflow-hidden rounded-full bg-gray-100">
              <div className="w-full rounded-full bg-[#aa3bff]" style={{ height: `${c.relationship[key]}%` }} />
            </div>
            <span className="text-[10px] text-gray-400">{label}</span>
          </div>
        ))}
      </div>

      {expanded && (
        <div className="mt-3 space-y-1.5 border-t border-gray-100 pt-3">
          {RELATIONSHIP_DIMENSIONS.map(({ key, label }) => (
            <div key={key} className="flex items-center justify-between text-xs text-gray-500">
              <span>{label}</span>
              <span>
                {c.relationship[key]}/100 · {dimensionQualifier(c.relationship[key])}
              </span>
            </div>
          ))}

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
