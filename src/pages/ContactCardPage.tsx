import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate, useParams } from 'react-router-dom'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { Avatar } from '../components/Avatar'
import { ActionSheet } from '../components/ActionSheet'

export function ContactCardPage() {
  const { contactId } = useParams()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)

  const contact = useLiveQuery(() => (contactId ? db.contacts.get(contactId) : undefined), [contactId])
  const conversation = useLiveQuery(
    () => (contactId ? db.conversations.where('contactId').equals(contactId).first() : undefined),
    [contactId],
  )

  if (contact === undefined) return null
  if (contact === null || !contactId) {
    return (
      <div className="flex min-h-full flex-col bg-[#f4f4f6]">
        <TopBar title="联系人" showBack />
        <p className="px-4 py-10 text-center text-sm text-gray-400">该联系人已被删除</p>
      </div>
    )
  }

  async function handleChat() {
    let conv = conversation
    if (!conv) {
      const now = Date.now()
      conv = { id: uuid(), contactId: contactId!, pinned: false, createdAt: now, updatedAt: now }
      await db.conversations.add(conv)
    }
    navigate(`/chat/${conv.id}`)
  }

  async function handleDelete() {
    if (conversation) {
      await db.messages.where('conversationId').equals(conversation.id).delete()
      await db.conversations.delete(conversation.id)
    }
    await db.contacts.delete(contactId!)
    navigate('/contacts', { replace: true })
  }

  return (
    <div className="relative flex min-h-full flex-col bg-[#f4f4f6]">
      <TopBar title="联系人名片" showBack />

      <section className="mt-3 flex flex-col items-center gap-2 bg-white px-4 py-8">
        <Avatar avatar={contact.avatar} color={contact.avatarColor} size={80} />
        <h2 className="text-lg font-medium text-gray-900">{contact.name}</h2>
      </section>

      <section className="mt-3 bg-white px-4 py-4">
        <h3 className="mb-2 text-xs font-medium text-gray-400">人物设定</h3>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-600">
          {contact.systemPrompt}
        </p>
      </section>

      <div className="mt-3 flex flex-col gap-2 bg-white px-4 py-4">
        <button onClick={handleChat} className="w-full rounded-lg bg-gray-900 py-2.5 text-sm text-white">
          发消息
        </button>
        <button
          onClick={() => navigate(`/contact/${contactId}/edit`)}
          className="w-full rounded-lg bg-gray-100 py-2.5 text-sm text-gray-700"
        >
          编辑资料
        </button>
        <button onClick={() => setMenuOpen(true)} className="w-full rounded-lg bg-gray-100 py-2.5 text-sm text-red-500">
          删除联系人
        </button>
      </div>

      {menuOpen && (
        <ActionSheet
          onClose={() => setMenuOpen(false)}
          options={[{ label: '确认删除该联系人及聊天记录', onSelect: handleDelete, danger: true }]}
        />
      )}
    </div>
  )
}
