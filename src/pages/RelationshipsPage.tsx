import { useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate } from 'react-router-dom'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { Avatar } from '../components/Avatar'
import { displayName } from '../lib/contact'
import { RELATIONSHIP_DIMENSIONS, relationshipStageLabel } from '../lib/relationship'

export function RelationshipsPage() {
  const navigate = useNavigate()
  const contactsRaw = useLiveQuery(() => db.contacts.toArray(), []) ?? []
  const contacts = useMemo(
    () => [...contactsRaw].sort((a, b) => b.relationship.affection - a.relationship.affection),
    [contactsRaw],
  )

  return (
    <div className="flex min-h-full flex-col bg-[#f4f4f6]">
      <TopBar title="关系网" showBack />

      <p className="px-4 pt-3 pb-1 text-xs text-gray-400">
        跟据你们的聊天内容自动评估 只影响语气不会改变TA的性格
      </p>

      {contacts.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-gray-400">还没有联系人</p>
      ) : (
        <div className="mt-2 flex-1 space-y-2 px-4 pb-4">
          {contacts.map((c) => (
            <button
              key={c.id}
              onClick={() => navigate(`/contact/${c.id}`)}
              className="block w-full rounded-xl bg-white p-3 text-left"
            >
              <div className="mb-2 flex items-center gap-3">
                <Avatar avatar={c.avatar} color={c.avatarColor} size={40} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-medium text-gray-900">{displayName(c)}</p>
                </div>
                <span className="shrink-0 rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-600">
                  {relationshipStageLabel(c.relationship)}
                </span>
              </div>
              <div className="grid grid-cols-5 gap-2">
                {RELATIONSHIP_DIMENSIONS.map(({ key, label }) => (
                  <div key={key} className="text-center">
                    <div className="mx-auto mb-1 flex h-10 w-2 flex-col justify-end overflow-hidden rounded-full bg-gray-100">
                      <div
                        className="w-full rounded-full bg-[#aa3bff]"
                        style={{ height: `${c.relationship[key]}%` }}
                      />
                    </div>
                    <span className="text-[10px] text-gray-400">{label}</span>
                  </div>
                ))}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
