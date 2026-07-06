import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate } from 'react-router-dom'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { Avatar } from '../components/Avatar'
import { displayName } from '../lib/contact'
import { formatCurrency } from '../lib/wallet'
import { useSettingsStore } from '../store/useSettingsStore'
import { triggerAiTurn } from '../lib/chatEngine'
import type { InventoryItem } from '../types'

export function WarehousePage() {
  const navigate = useNavigate()
  const items = useLiveQuery(() => db.inventory.orderBy('acquiredAt').reverse().toArray(), []) ?? []
  const contacts = useLiveQuery(() => db.contacts.toArray(), []) ?? []
  const stickers = useLiveQuery(() => db.stickers.toArray(), []) ?? []
  const settings = useSettingsStore()
  const [gifting, setGifting] = useState<InventoryItem | null>(null)

  async function handleGift(contactId: string) {
    if (!gifting) return
    const contact = contacts.find((c) => c.id === contactId)
    const conv = await db.conversations.where('contactId').equals(contactId).first()
    if (conv) {
      await db.messages.add({
        id: uuid(),
        conversationId: conv.id,
        role: 'user',
        type: 'gift',
        content: gifting.name,
        gift: { name: gifting.name, icon: gifting.icon, description: gifting.description },
        createdAt: Date.now(),
      })
      await db.conversations.update(conv.id, { updatedAt: Date.now() })
      if (contact) triggerAiTurn(conv.id, contact, settings, stickers)
    }
    await db.inventory.delete(gifting.id)
    setGifting(null)
    navigate(conv ? `/chat/${conv.id}` : '/contacts')
  }

  return (
    <div className="relative flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
      <TopBar title="仓库" showBack />
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {items.length === 0 ? (
          <p className="py-10 text-center text-sm text-gray-400">仓库还是空的 去商城逛逛吧</p>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {items.map((item) => (
              <div key={item.id} className="rounded-xl bg-white p-3">
                <div className="mb-2 flex h-16 items-center justify-center rounded-lg bg-gray-50 text-3xl">
                  {item.icon}
                </div>
                <p className="truncate text-sm font-medium text-gray-900">{item.name}</p>
                <p className="mt-0.5 line-clamp-2 text-xs text-gray-400">{item.description}</p>
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-xs text-gray-400">{formatCurrency(item.price, settings)}</span>
                  <button
                    onClick={() => setGifting(item)}
                    className="rounded-lg bg-gray-100 px-2.5 py-1 text-xs text-gray-700"
                  >
                    赠送
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {gifting && (
        <div className="absolute inset-0 z-30 flex items-end bg-black/30" onClick={() => setGifting(null)}>
          <div
            className="max-h-[70vh] w-full overflow-y-auto rounded-t-2xl bg-white p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-3 text-center text-[15px] font-medium text-gray-900">
              把「{gifting.name}」送给谁
            </h2>
            {contacts.length === 0 ? (
              <p className="py-6 text-center text-sm text-gray-400">还没有联系人</p>
            ) : (
              <div className="space-y-1">
                {contacts.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => handleGift(c.id)}
                    className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left active:bg-gray-50"
                  >
                    <Avatar avatar={c.avatar} color={c.avatarColor} size={36} />
                    <span className="text-sm text-gray-900">{displayName(c)}</span>
                  </button>
                ))}
              </div>
            )}
            <button
              onClick={() => setGifting(null)}
              className="mt-2 w-full rounded-lg bg-gray-100 py-2.5 text-sm text-gray-600"
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
