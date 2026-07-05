import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { Avatar } from '../components/Avatar'
import { AvatarPicker } from '../components/AvatarPicker'
import { randomAvatarColor } from '../lib/colors'
import { displayName } from '../lib/contact'

const GROUP_AVATAR_DEFAULT = '👥'
const MIN_MEMBERS = 2

export function GroupAddPage() {
  const navigate = useNavigate()
  const contacts = useLiveQuery(() => db.contacts.toArray(), []) ?? []

  const [name, setName] = useState('')
  const [avatar, setAvatar] = useState(GROUP_AVATAR_DEFAULT)
  const [pickingAvatar, setPickingAvatar] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [creating, setCreating] = useState(false)

  function toggleMember(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  async function handleCreate() {
    const trimmedName = name.trim()
    if (!trimmedName || selected.length < MIN_MEMBERS || creating) return
    setCreating(true)
    try {
      const now = Date.now()
      const groupId = uuid()
      await db.groups.add({
        id: groupId,
        name: trimmedName,
        avatar,
        avatarColor: randomAvatarColor(),
        memberContactIds: selected,
        createdAt: now,
        memoryMessageCursor: 0,
      })
      const conversationId = uuid()
      await db.conversations.add({ id: conversationId, groupId, pinned: false, createdAt: now, updatedAt: now })
      navigate(`/chat/${conversationId}`, { replace: true })
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
      <TopBar title="发起群聊" showBack />

      <div className="mt-3 flex-1 overflow-y-auto bg-white px-4 py-4">
        <label className="mb-1 block text-xs text-gray-400">群头像</label>
        <button
          onClick={() => setPickingAvatar(true)}
          className="mb-4 flex items-center gap-3 rounded-lg border border-gray-200 px-3 py-2"
        >
          <Avatar avatar={avatar} size={44} />
          <span className="text-sm text-gray-500">点击选择</span>
        </button>

        <label className="mb-1 block text-xs text-gray-400">群名称</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="给这个群起个名字"
          maxLength={20}
          className="mb-4 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
        />

        <label className="mb-2 block text-xs font-medium text-gray-400">
          选择群成员（至少{MIN_MEMBERS}人{selected.length > 0 ? ` · 已选${selected.length}人` : ''}）
        </label>
        {contacts.length === 0 ? (
          <p className="text-sm text-gray-400">还没有联系人 先去"联系人"页添加几个吧</p>
        ) : (
          <div className="space-y-1">
            {contacts.map((c) => {
              const checked = selected.includes(c.id)
              return (
                <button
                  key={c.id}
                  onClick={() => toggleMember(c.id)}
                  className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left active:bg-gray-50"
                >
                  <div
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
                      checked ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-300'
                    }`}
                  >
                    {checked && '✓'}
                  </div>
                  <Avatar avatar={c.avatar} color={c.avatarColor} size={36} />
                  <span className="text-sm text-gray-800">{displayName(c)}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      <div className="sticky bottom-0 border-t border-gray-100 bg-white p-3">
        <button
          onClick={handleCreate}
          disabled={!name.trim() || selected.length < MIN_MEMBERS || creating}
          className="w-full rounded-lg bg-gray-900 py-2.5 text-sm text-white disabled:opacity-40"
        >
          {creating ? '创建中…' : '创建群聊'}
        </button>
      </div>

      {pickingAvatar && <AvatarPicker onSelect={setAvatar} onClose={() => setPickingAvatar(false)} />}
    </div>
  )
}
