import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate } from 'react-router-dom'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { isAiTestId } from '../lib/aiTestIsolation'
import { TopBar } from '../components/TopBar'
import { Avatar } from '../components/Avatar'
import { displayName } from '../lib/contact'
import { formatCurrency } from '../lib/wallet'
import { useSettingsStore } from '../store/useSettingsStore'
import { useModuleEnabled } from '../features'
import { triggerAiTurn } from '../lib/chatEngine'
import { consumeInventoryItem, discardInventoryItem } from '../lib/inventory'
import type { InventoryItem } from '../types'

export function WarehousePage() {
  const navigate = useNavigate()
  const items = useLiveQuery(() => db.inventory.orderBy('acquiredAt').reverse().toArray(), []) ?? []
  const contacts = (useLiveQuery(() => db.contacts.toArray(), []) ?? []).filter((item) => !isAiTestId(item.id))
  const stickers = useLiveQuery(() => db.stickers.toArray(), []) ?? []
  const settings = useSettingsStore()
  const shopEnabled = useModuleEnabled('shop')
  const [gifting, setGifting] = useState<InventoryItem | null>(null)
  const [toast, setToast] = useState('')

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(''), 1800)
    return () => clearTimeout(timer)
  }, [toast])

  async function handleGift(contactId: string) {
    if (!gifting) return
    const contact = contacts.find((c) => c.id === contactId)
    const conv = await db.conversations.where('contactId').equals(contactId).first()
    const consumed = await db.transaction('rw', db.inventory, db.messages, db.conversations, async () => {
      const didConsume = await consumeInventoryItem(gifting.id)
      if (!didConsume) return false
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
      }
      return true
    })
    if (!consumed) {
      setGifting(null)
      setToast('这件物品已经用完了')
      return
    }
    if (conv && contact) void triggerAiTurn(conv.id, contact, settings, stickers)
    setGifting(null)
    void navigate(conv ? `/chat/${conv.id}` : '/contacts')
  }

  async function handleDiscard(item: InventoryItem) {
    if (!window.confirm(`确定丢弃「${item.name}」吗？丢弃后不会退还金币。`)) return
    await discardInventoryItem(item.id)
    setToast(`已丢弃「${item.name}」`)
  }

  return (
    <div className="relative flex h-[var(--app-height)] flex-col overflow-hidden bg-[var(--ui-bg)]">
      <TopBar title="仓库" showBack />
      <div className="flex-1 overflow-y-auto pb-6">
        <section className="border-b border-[var(--ui-border-soft)] bg-[var(--ui-surface)] px-4 pb-4 pt-5">
          <p className="text-xs font-medium text-[var(--ui-text-3)]">我的物品</p>
          <h1 className="ui-font-display mt-1 text-lg font-semibold text-[var(--ui-text)]">仓库里有 {items.length} 件东西</h1>
          <p className="mt-2 text-xs leading-relaxed text-[var(--ui-text-3)]">购买的物品会保存在这里。赠送后会进入对应聊天，丢弃不会退还金币。</p>
        </section>
        <div className="px-4 pt-4">
        {items.length === 0 ? (
          <div className="rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] px-5 py-10 text-center shadow-[var(--ui-shadow)]"><p className="text-sm text-[var(--ui-text-2)]">仓库还是空的</p>{shopEnabled && <button type="button" onClick={() => navigate('/shop')} className="mt-3 rounded-[var(--ui-radius-control)] bg-[var(--ui-action)] px-4 py-2 text-sm text-[var(--ui-on-action)]">去商城逛逛</button>}</div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {items.map((item) => (
              <div key={item.id} className="rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] p-3 shadow-[var(--ui-shadow)]">
                <div className="mb-2 flex h-16 items-center justify-center rounded-lg bg-gray-50 text-3xl">
                  {item.icon}
                </div>
                <p className="truncate text-sm font-medium text-gray-900">{item.name}</p>
                <p className="mt-0.5 line-clamp-2 text-xs text-gray-400">{item.description}</p>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <p className="min-w-0 text-xs text-gray-400">{formatCurrency(item.price, settings)}</p>
                  <div className="flex gap-1">
                    <button
                      onClick={() => setGifting(item)}
                      className="rounded-lg bg-gray-100 px-2 py-1 text-xs text-gray-700"
                    >
                      赠送
                    </button>
                    <button
                      onClick={() => void handleDiscard(item)}
                      className="rounded-lg bg-red-50 px-2 py-1 text-xs text-red-500"
                    >
                      丢弃
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        </div>
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

      {toast && (
        <p className="absolute bottom-4 left-1/2 z-40 -translate-x-1/2 whitespace-nowrap rounded-full bg-black/80 px-4 py-2 text-xs text-white">
          {toast}
        </p>
      )}
    </div>
  )
}
