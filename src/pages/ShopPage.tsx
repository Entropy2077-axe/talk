import { useEffect, useState } from 'react'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { useSettingsStore } from '../store/useSettingsStore'
import { chatCompletion } from '../lib/deepseek'
import { buildShopPrompt, parseShopProducts, type GeneratedProduct } from '../lib/shop'
import { formatCurrency } from '../lib/wallet'

export function ShopPage() {
  const settings = useSettingsStore()
  const [query, setQuery] = useState('')
  const [products, setProducts] = useState<GeneratedProduct[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [hasBrowsed, setHasBrowsed] = useState(false)

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), 1800)
    return () => clearTimeout(t)
  }, [toast])

  async function generate(searchQuery: string | null) {
    if (!settings.apiKey) {
      setError('还没有配置API Key 请先去"我-设置"里填写')
      return
    }
    setLoading(true)
    setError('')
    try {
      const raw = await chatCompletion({
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        model: settings.shopModel,
        messages: [
          { role: 'system', content: buildShopPrompt(searchQuery) },
          { role: 'user', content: searchQuery ?? '推荐一些商品' },
        ],
        jsonMode: true,
      })
      const list = parseShopProducts(raw)
      if (list.length === 0) throw new Error('没有生成出商品 换个词再试试')
      setProducts(list)
      setHasBrowsed(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function handleBuy(product: GeneratedProduct) {
    if (settings.walletBalance < product.price) {
      setToast('金币不够啦')
      return
    }
    settings.setSettings({ walletBalance: settings.walletBalance - product.price })
    await db.inventory.add({
      id: uuid(),
      name: product.name,
      description: product.description,
      icon: product.icon,
      price: product.price,
      acquiredAt: Date.now(),
    })
    setToast(`已购买「${product.name}」`)
  }

  return (
    <div className="relative flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
      <TopBar
        title="商城"
        showBack
        right={<span className="pr-1 text-sm text-gray-500">{formatCurrency(settings.walletBalance)}</span>}
      />
      <div className="flex-1 overflow-y-auto">

      <div className="flex gap-2 px-4 pt-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              generate(query.trim() || null)
            }
          }}
          placeholder="搜索想买的东西"
          className="flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm"
        />
        <button
          onClick={() => generate(query.trim() || null)}
          disabled={loading}
          className="rounded-lg bg-gray-900 px-4 py-2 text-sm text-white disabled:opacity-40"
        >
          {loading ? '生成中…' : '搜索'}
        </button>
      </div>

      {!hasBrowsed && !loading && (
        <button
          onClick={() => generate(null)}
          className="mx-4 mt-3 rounded-lg bg-white py-2.5 text-sm text-gray-600 shadow-sm"
        >
          随便逛逛
        </button>
      )}

      {error && <p className="mx-4 mt-3 text-xs text-red-500">{error}</p>}

      <div className="mt-3 flex-1 px-4 pb-4">
        {products.length > 0 && (
          <div className="grid grid-cols-2 gap-3">
            {products.map((p, i) => (
              <div key={i} className="rounded-xl bg-white p-3">
                <div className="mb-2 flex h-16 items-center justify-center rounded-lg bg-gray-50 text-3xl">
                  {p.icon}
                </div>
                <p className="truncate text-sm font-medium text-gray-900">{p.name}</p>
                <p className="mt-0.5 line-clamp-2 text-xs text-gray-400">{p.description}</p>
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-xs font-medium text-[#aa3bff]">{formatCurrency(p.price)}</span>
                  <button
                    onClick={() => handleBuy(p)}
                    className="rounded-lg bg-gray-900 px-2.5 py-1 text-xs text-white"
                  >
                    购买
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      </div>

      {toast && (
        <p className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/80 px-4 py-2 text-xs text-white">
          {toast}
        </p>
      )}
    </div>
  )
}
