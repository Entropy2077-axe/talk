import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { TopBar } from '../components/TopBar'
import {
  isStickerProviderReady,
  STICKER_PROVIDER_INFO,
} from '../lib/mediaProviders'
import { searchRemoteStickers, type RemoteStickerResult } from '../lib/remoteMedia'
import { useSettingsStore } from '../store/useSettingsStore'
import type { StickerProviderId, StickerProvidersSettings } from '../types'
import { friendlyConnectionError } from '../lib/connectionError'

const inputClass = 'w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-gray-400'
const labelClass = 'mb-1 block text-xs text-gray-500'

function isKnownProvider(value: string | undefined): value is Exclude<StickerProviderId, 'none'> {
  return STICKER_PROVIDER_INFO.some((item) => item.id === value)
}

export function StickerProviderSettingsPage() {
  const navigate = useNavigate()
  const { providerId } = useParams()
  const stickerProvider = useSettingsStore((state) => state.stickerProvider)
  const providers = useSettingsStore((state) => state.stickerProviders)
  const setSettings = useSettingsStore((state) => state.setSettings)
  const [testing, setTesting] = useState(false)
  const [resultText, setResultText] = useState('')
  const [results, setResults] = useState<RemoteStickerResult[]>([])

  if (!isKnownProvider(providerId)) {
    return (
      <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
        <TopBar title="表情包接口" showBack />
        <div className="p-4 text-sm text-gray-500">这个服务不存在。</div>
      </div>
    )
  }

  const provider = providerId
  const info = STICKER_PROVIDER_INFO.find((item) => item.id === provider)!

  function updateProvider<K extends keyof StickerProvidersSettings>(
    key: K,
    patch: Partial<StickerProvidersSettings[K]>,
  ) {
    const current = useSettingsStore.getState().stickerProviders
    setSettings({
      stickerProviders: {
        ...current,
        [key]: { ...current[key], ...patch },
      },
    })
    setResultText('')
  }

  const candidate = { stickerProvider: provider, stickerProviders: providers }
  const configured = isStickerProviderReady(candidate)

  function activate() {
    if (!configured) {
      setResultText(provider === 'custom' ? '请先填写接口地址。' : '请先填写 API Key。')
      return
    }
    setSettings({ stickerProvider: provider })
    setResultText(`${info.name} 已启用。`)
  }

  async function testProvider() {
    if (!configured) {
      setResultText(provider === 'custom' ? '请先填写接口地址。' : '请先填写 API Key。')
      return
    }
    setTesting(true)
    setResultText('')
    setResults([])
    try {
      const found = await searchRemoteStickers(candidate, '开心 猫咪')
      if (found.length === 0) throw new Error('接口连接成功，但没有解析到表情图片')
      setResults(found.slice(0, 8))
      setSettings({ stickerProvider: provider })
      setResultText(`连接成功，找到 ${found.length} 个结果，并已启用 ${info.name}。`)
    } catch (error) {
      setResultText(friendlyConnectionError(error, info.name))
    } finally {
      setTesting(false)
    }
  }

  const active = stickerProvider === provider

  return (
    <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
      <TopBar title={info.name} showBack />
      <div className="flex-1 overflow-y-auto pb-6">
        <section className="mt-3 bg-white px-4 py-4">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-medium text-gray-900">{info.name}</h2>
              <p className="mt-1 text-xs leading-relaxed text-gray-400">{info.description}</p>
            </div>
            <span className={`shrink-0 rounded-full px-2 py-1 text-[11px] ${active ? 'bg-green-50 text-green-600' : 'bg-gray-100 text-gray-500'}`}>
              {active ? '使用中' : '未启用'}
            </span>
          </div>

          {provider === 'giphy' && (
            <>
              <label className={labelClass}>GIPHY API Key</label>
              <input
                aria-label="GIPHY API Key"
                type="password"
                value={providers.giphy.apiKey}
                onChange={(event) => updateProvider('giphy', { apiKey: event.target.value })}
                placeholder="粘贴 API Key"
                className={inputClass}
              />
              <div className="mt-3 grid grid-cols-2 gap-2">
                <label>
                  <span className={labelClass}>内容分级</span>
                  <select value={providers.giphy.rating} onChange={(event) => updateProvider('giphy', { rating: event.target.value as StickerProvidersSettings['giphy']['rating'] })} className={inputClass}>
                    <option value="g">G（最严格）</option>
                    <option value="pg">PG</option>
                    <option value="pg-13">PG-13</option>
                    <option value="r">R</option>
                  </select>
                </label>
                <label>
                  <span className={labelClass}>搜索语言</span>
                  <select value={providers.giphy.language} onChange={(event) => updateProvider('giphy', { language: event.target.value })} className={inputClass}>
                    <option value="zh">中文</option>
                    <option value="en">English</option>
                    <option value="ja">日本語</option>
                  </select>
                </label>
              </div>
              <p className="mt-3 text-[11px] text-gray-400">接口地址和请求参数已经预设。Powered by GIPHY</p>
            </>
          )}

          {(provider === 'klipy' || provider === 'tenor') && (() => {
            const config = providers[provider]
            return (
              <>
                <label className={labelClass}>{info.name} API Key</label>
                <input
                  aria-label={`${info.name} API Key`}
                  type="password"
                  value={config.apiKey}
                  onChange={(event) => updateProvider(provider, { apiKey: event.target.value })}
                  placeholder="粘贴 API Key"
                  className={inputClass}
                />
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <label>
                    <span className={labelClass}>内容过滤</span>
                    <select
                      value={config.contentFilter}
                      onChange={(event) => updateProvider(provider, { contentFilter: event.target.value as typeof config.contentFilter })}
                      className={inputClass}
                    >
                      <option value="high">严格</option>
                      <option value="medium">中等</option>
                      <option value="low">较少</option>
                      <option value="off">关闭</option>
                    </select>
                  </label>
                  <label>
                    <span className={labelClass}>区域</span>
                    <select value={config.locale} onChange={(event) => updateProvider(provider, { locale: event.target.value })} className={inputClass}>
                      <option value="zh_CN">中文</option>
                      <option value="en_US">English</option>
                      <option value="ja_JP">日本語</option>
                    </select>
                  </label>
                </div>
                <p className="mt-3 text-[11px] leading-relaxed text-gray-400">
                  {provider === 'klipy'
                    ? '接口参数已按 KLIPY 的 Tenor 兼容格式预设。Powered by KLIPY'
                    : 'Tenor 目前主要用于兼容已有 Key；新用户建议优先选择 GIPHY 或 KLIPY。'}
                </p>
              </>
            )
          })()}

          {provider === 'custom' && (
            <>
              <label className={labelClass}>GET 接口地址</label>
              <input
                aria-label="自定义表情包接口地址"
                value={providers.custom.endpoint}
                onChange={(event) => updateProvider('custom', { endpoint: event.target.value })}
                placeholder="https://example.com/search?q={query}"
                className={inputClass}
              />
              <p className="mt-1 text-[11px] text-gray-400"><code>{'{query}'}</code> 会替换为搜索词，<code>{'{apiKey}'}</code> 会替换为 Key。</p>
              <label className={`${labelClass} mt-3`}>API Key（可选）</label>
              <input
                aria-label="自定义表情包 API Key"
                type="password"
                value={providers.custom.apiKey}
                onChange={(event) => updateProvider('custom', { apiKey: event.target.value })}
                placeholder="没有就留空"
                className={inputClass}
              />
              <div className="mt-3 grid grid-cols-2 gap-2">
                <label>
                  <span className={labelClass}>鉴权方式</span>
                  <select value={providers.custom.authMode} onChange={(event) => updateProvider('custom', { authMode: event.target.value as StickerProvidersSettings['custom']['authMode'] })} className={inputClass}>
                    <option value="none">无</option>
                    <option value="bearer">Bearer</option>
                    <option value="x-api-key">X-API-Key</option>
                    <option value="query">api_key 参数</option>
                  </select>
                </label>
                <label>
                  <span className={labelClass}>返回字段（可选）</span>
                  <input value={providers.custom.responsePath} onChange={(event) => updateProvider('custom', { responsePath: event.target.value })} placeholder="data.results" className={inputClass} />
                </label>
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-gray-400">支持直接图片、图片 URL 数组，以及嵌套 JSON。常用服务无需来这里填写。</p>
            </>
          )}

          <div className="mt-4 grid grid-cols-2 gap-2">
            <button type="button" onClick={activate} disabled={active} className="rounded-lg bg-gray-100 py-2.5 text-sm text-gray-700 disabled:opacity-50">
              {active ? '已启用' : '启用此服务'}
            </button>
            <button type="button" onClick={() => void testProvider()} disabled={testing} className="rounded-lg bg-gray-900 py-2.5 text-sm text-white disabled:opacity-50">
              {testing ? '测试中…' : '测试并启用'}
            </button>
          </div>
          {resultText && <p className={`mt-3 text-xs ${results.length > 0 ? 'text-green-600' : 'text-red-500'}`}>{resultText}</p>}
        </section>

        {results.length > 0 && (
          <section className="mt-3 bg-white px-4 py-4">
            <h2 className="mb-3 text-xs font-medium text-gray-400">搜索预览</h2>
            <div className="grid grid-cols-4 gap-2">
              {results.map((item, index) => (
                <img key={`${item.url}-${index}`} src={item.url} alt={item.name || '表情预览'} className="aspect-square w-full rounded-lg bg-gray-50 object-contain" />
              ))}
            </div>
          </section>
        )}

        <button type="button" onClick={() => navigate('/stickers/remote')} className="mx-4 mt-4 w-[calc(100%-2rem)] rounded-lg bg-white py-2.5 text-sm text-gray-600">
          返回服务列表
        </button>
      </div>
    </div>
  )
}
