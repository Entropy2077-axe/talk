import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate, useParams } from 'react-router-dom'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { Avatar } from '../components/Avatar'
import { displayName } from '../lib/contact'
import type { Contact } from '../types'

const EMPTY_CONTACTS: Contact[] = []

export function GroupInfoPage() {
  const { groupId } = useParams()
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState(false)
  const [editingMembers, setEditingMembers] = useState(false)
  const [selectedToAdd, setSelectedToAdd] = useState<string[]>([])

  const group = useLiveQuery(() => (groupId ? db.groups.get(groupId) : undefined), [groupId])
  const allContacts = useLiveQuery(() => db.contacts.toArray(), []) ?? EMPTY_CONTACTS
  const membersRaw = useLiveQuery(() => (group ? db.contacts.bulkGet(group.memberContactIds) : []), [group])
  const members = (membersRaw ?? []).filter((c): c is Contact => !!c)

  const addableContacts = useMemo(() => {
    if (!group) return []
    const memberIds = new Set(group.memberContactIds)
    return allContacts.filter((c) => !memberIds.has(c.id))
  }, [allContacts, group])

  function toggleAdd(id: string) {
    setSelectedToAdd((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  async function handleAddMembers() {
    if (!group || selectedToAdd.length === 0) return
    const next = Array.from(new Set([...group.memberContactIds, ...selectedToAdd]))
    await db.groups.update(group.id, { memberContactIds: next })
    setSelectedToAdd([])
  }

  async function handleRemoveMember(contactId: string) {
    if (!group || group.memberContactIds.length <= 1) return
    await db.groups.update(group.id, {
      memberContactIds: group.memberContactIds.filter((id) => id !== contactId),
    })
  }

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
          <p className="text-xs text-gray-400">{members.length} 位成员</p>
        </div>

        <div className="mb-2 flex items-center justify-between">
          <label className="block text-xs font-medium text-gray-400">群成员</label>
          <button onClick={() => setEditingMembers((v) => !v)} className="text-xs text-gray-500 underline">
            {editingMembers ? '完成' : '管理'}
          </button>
        </div>

        <div className="mb-4 space-y-1">
          {members.map((c) => (
            <div key={c.id} className="flex items-center gap-2 rounded-lg px-2 py-2">
              <button
                onClick={() => navigate(`/contact/${c.id}`)}
                className="flex flex-1 items-center gap-3 text-left active:bg-gray-50"
              >
                <Avatar avatar={c.avatar} color={c.avatarColor} size={36} />
                <span className="text-sm text-gray-800">{displayName(c)}</span>
              </button>
              {editingMembers && (
                <button
                  onClick={() => void handleRemoveMember(c.id)}
                  disabled={group.memberContactIds.length <= 1}
                  className="rounded-lg bg-red-50 px-2 py-1 text-xs text-red-500 disabled:opacity-40"
                >
                  移除
                </button>
              )}
            </div>
          ))}
        </div>

        {editingMembers && (
          <section className="mb-6 rounded-lg bg-gray-50 p-3">
            <h3 className="mb-2 text-xs font-medium text-gray-400">添加成员</h3>
            {addableContacts.length === 0 ? (
              <p className="text-sm text-gray-400">没有可添加的联系人</p>
            ) : (
              <div className="space-y-1">
                {addableContacts.map((c) => {
                  const checked = selectedToAdd.includes(c.id)
                  return (
                    <button
                      key={c.id}
                      onClick={() => toggleAdd(c.id)}
                      className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left active:bg-gray-50"
                    >
                      <div
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
                          checked ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-300'
                        }`}
                      >
                        {checked && '✓'}
                      </div>
                      <Avatar avatar={c.avatar} color={c.avatarColor} size={32} />
                      <span className="text-sm text-gray-800">{displayName(c)}</span>
                    </button>
                  )
                })}
                <button
                  onClick={() => void handleAddMembers()}
                  disabled={selectedToAdd.length === 0}
                  className="mt-2 w-full rounded-lg bg-gray-900 py-2 text-sm text-white disabled:opacity-40"
                >
                  添加选中的 {selectedToAdd.length} 人
                </button>
              </div>
            )}
          </section>
        )}

        {confirming ? (
          <div className="rounded-lg bg-red-50 p-3">
            <p className="mb-2 text-xs text-red-500">解散后聊天记录也会一起删除，无法恢复。确定吗？</p>
            <div className="flex gap-2">
              <button onClick={() => setConfirming(false)} className="flex-1 rounded-lg bg-gray-100 py-2 text-xs text-gray-600">
                取消
              </button>
              <button onClick={handleDisband} className="flex-1 rounded-lg bg-red-500 py-2 text-xs text-white">
                确认解散
              </button>
            </div>
          </div>
        ) : (
          <button onClick={() => setConfirming(true)} className="w-full rounded-lg bg-red-50 py-2.5 text-sm text-red-500">
            解散群聊
          </button>
        )}
      </div>
    </div>
  )
}
