import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate, useParams } from 'react-router-dom'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { Avatar } from '../components/Avatar'
import { displayName } from '../lib/contact'
import type { Contact } from '../types'

export function GroupInfoPage() {
  const { groupId } = useParams()
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState(false)

  const group = useLiveQuery(() => (groupId ? db.groups.get(groupId) : undefined), [groupId])
  const membersRaw = useLiveQuery(() => (group ? db.contacts.bulkGet(group.memberContactIds) : []), [group])
  const members = (membersRaw ?? []).filter((c): c is Contact => !!c)

  async function handleDisband() {
    if (!group) return
    const conv = await db.conversations.where('groupId').equals(group.id).first()
    if (conv) {
      await db.messages.where('conversationId').equals(conv.id).delete()
      await db.conversations.delete(conv.id)
    }
    await db.groups.delete(group.id)
    navigate('/', { replace: true })
  }

  if (group === undefined) return null
  if (group === null || !groupId) {
    return (
      <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
        <TopBar title="群聊" showBack />
        <p className="px-4 py-10 text-center text-sm text-gray-400">该群聊已被解散</p>
      </div>
    )
  }

  return (
    <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
      <TopBar title="群聊信息" showBack />

      <div className="mt-3 flex-1 overflow-y-auto bg-white px-4 py-4">
        <div className="mb-5 flex flex-col items-center gap-2">
          <Avatar avatar={group.avatar} color={group.avatarColor} size={64} />
          <p className="text-[15px] font-medium text-gray-900">{group.name}</p>
          <p className="text-xs text-gray-400">{members.length}位成员</p>
        </div>

        <label className="mb-2 block text-xs font-medium text-gray-400">群成员</label>
        <div className="mb-6 space-y-1">
          {members.map((c) => (
            <button
              key={c.id}
              onClick={() => navigate(`/contact/${c.id}`)}
              className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left active:bg-gray-50"
            >
              <Avatar avatar={c.avatar} color={c.avatarColor} size={36} />
              <span className="text-sm text-gray-800">{displayName(c)}</span>
            </button>
          ))}
        </div>

        {confirming ? (
          <div className="rounded-lg bg-red-50 p-3">
            <p className="mb-2 text-xs text-red-500">解散后聊天记录也会一并删除 无法恢复 确定吗</p>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirming(false)}
                className="flex-1 rounded-lg bg-gray-100 py-2 text-xs text-gray-600"
              >
                取消
              </button>
              <button onClick={handleDisband} className="flex-1 rounded-lg bg-red-500 py-2 text-xs text-white">
                确认解散
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            className="w-full rounded-lg bg-red-50 py-2.5 text-sm text-red-500"
          >
            解散群聊
          </button>
        )}
      </div>
    </div>
  )
}
