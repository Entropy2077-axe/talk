import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate } from 'react-router-dom'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { Avatar } from '../components/Avatar'
import { displayName } from '../lib/contact'
import { formatCurrency } from '../lib/wallet'
import { useSettingsStore } from '../store/useSettingsStore'
import { useModuleEnabled } from '../features'
import { triggerAiTurn } from '../lib/chatEngine'
import { USER_WALLET_ID } from '../lib/finance'
import { consumeInventoryItem, inventoryQuantity, purchaseInventoryProduct } from '../lib/inventory'
import type { InventoryItem } from '../types'

export function WarehousePage() {
  const navigate = useNavigate()
  const items = useLiveQuery(() => db.inventory.orderBy('acquiredAt').reverse().toArray(), []) ?? []
  const contacts = useLiveQuery(() => db.contacts.toArray(), []) ?? []
  const stickers = useLiveQuery(() => db.stickers.toArray(), []) ?? []
  const settings = useSettingsStore()
  const wallet = useLiveQuery(() => db.walletAccounts.get(USER_WALLET_ID), [])
  const shopEnabled = useModuleEnabled('shop')
  const [gifting, setGifting] = useState<InventoryItem | null>(null)
  const [buyingId, setBuyingId] = useState('')
  const [toast, setToast] = useState('')

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(''), 1800)
    return () => clearTimeout(timer)
  }, [toast])

  async function handleGift(contactId: string) {
    if (!gifting) return
    if (inventoryQuantity(gifting) <= 0) {
      setGifting(null)
      setToast('这件物品已经用完了')
      return
    }
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
    if (conv && contact) triggerAiTurn(conv.id, contact, settings, stickers)
    setGifting(null)
    navigate(conv ? `/chat/${conv.id}` : '/contacts')
  }

  async function handleRepurchase(item: InventoryItem) {
    if (buyingId) return
    if ((wallet?.balance ?? 0) < item.price) {
      setToast('金币不够啦')
      return
    }
    setBuyingId(item.id)
    try {
      await purchaseInventoryProduct(item, `复购：${item.name}`)
      setToast(`已复购「${item.name}」`)
    } catch (error) {
      setToast(error instanceof Error ? error.message : '复购失败')
    } finally {
      setBuyingId('')
    }
  }

  return (
    <div className="relative flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
      <TopBar title="仓库" showBack />
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {items.length === 0 ? (
          <p className="py-10 text-center text-sm text-gray-400">
                {shopEnabled ? '仓库还是空的 去商城逛逛吧' : '仓库还是空的'}
              </p>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {items.map((item) => (
              <div key={item.id} className="rounded-xl bg-white p-3">
                <div className="mb-2 flex h-16 items-center justify-center rounded-lg bg-gray-50 text-3xl">
                  {item.icon}
                </div>
                <p className="truncate text-sm font-medium text-gray-900">{item.name}</p>
                <p className="mt-0.5 line-clamp-2 text-xs text-gray-400">{item.description}</p>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs text-gray-400">{formatCurrency(item.price, settings)}</p>
                    <p className={`mt-0.5 text-[11px] ${inventoryQuantity(item) > 0 ? 'text-gray-500' : 'text-amber-600'}`}>
                      {inventoryQuantity(item) > 0 ? `×${inventoryQuantity(item)}` : '已用完'}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <button
                      onClick={() => setGifting(item)}
                      disabled={inventoryQuantity(item) <= 0}
                      className="rounded-lg bg-gray-100 px-2 py-1 text-xs text-gray-700 disabled:text-gray-300"
                    >
                      赠送
                    </button>
                    <button
                      onClick={() => void handleRepurchase(item)}
                      disabled={!!buyingId}
                      className="rounded-lg bg-gray-900 px-2 py-1 text-xs text-white disabled:opacity-40"
                    >
                      {buyingId === item.id ? '购买中' : '复购'}
                    </button>
                  </div>
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

      {toast && (
        <p className="absolute bottom-4 left-1/2 z-40 -translate-x-1/2 whitespace-nowrap rounded-full bg-black/80 px-4 py-2 text-xs text-white">
          {toast}
        </p>
      )}
    </div>
  )
}
