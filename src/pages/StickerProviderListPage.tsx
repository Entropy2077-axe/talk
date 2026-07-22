import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/TopBar'
import {
  isStickerProviderReady,
  stickerProviderName,
  STICKER_PROVIDER_INFO,
} from '../lib/mediaProviders'
import { useSettingsStore } from '../store/useSettingsStore'

export function StickerProviderListPage() {
  const navigate = useNavigate()
  const stickerProvider = useSettingsStore((state) => state.stickerProvider)
  const stickerProviders = useSettingsStore((state) => state.stickerProviders)
  const setSettings = useSettingsStore((state) => state.setSettings)
  const ready = isStickerProviderReady({ stickerProvider, stickerProviders })

  return (
    <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
      <TopBar title="远程表情包" showBack />
      <div className="flex-1 overflow-y-auto pb-6">
        <section className="mt-3 bg-white px-4 py-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-900">当前服务</p>
              <p className={`mt-1 text-xs ${ready ? 'text-green-600' : 'text-gray-400'}`}>
                {stickerProviderName(stickerProvider)} · {ready ? '已就绪' : stickerProvider === 'none' ? '未启用' : '还需完成配置'}
              </p>
            </div>
            {stickerProvider !== 'none' && (
              <button
                type="button"
                onClick={() => setSettings({ stickerProvider: 'none' })}
                className="rounded-lg bg-gray-100 px-3 py-2 text-xs text-gray-600"
              >
                关闭
              </button>
            )}
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-gray-400">
            启用后，聊天输入区可以直接搜索远程表情；AI 联系人也会根据语境自动搜索并发送，不会把网络图片塞进你的本地表情库。
          </p>
        </section>

        <section className="mt-3 bg-white">
          <h2 className="px-4 pt-4 text-xs font-medium text-gray-400">选择服务</h2>
          <div className="mt-1">
            {STICKER_PROVIDER_INFO.map((item) => {
              const selected = stickerProvider === item.id
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => navigate(`/stickers/remote/${item.id}`)}
                  className="flex w-full items-center gap-3 border-b border-gray-100 px-4 py-3 text-left last:border-0"
                >
                  <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-sm font-semibold ${selected ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'}`}>
                    {item.name.slice(0, 2)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm text-gray-900">{item.name}</p>
                      {item.badge && <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">{item.badge}</span>}
                      {selected && <span className="text-[10px] text-green-600">使用中</span>}
                    </div>
                    <p className="mt-0.5 text-xs text-gray-400">{item.description}</p>
                  </div>
                  <span className="text-lg text-gray-300">›</span>
                </button>
              )
            })}
          </div>
        </section>

        <p className="px-4 pt-4 text-[11px] leading-relaxed text-gray-400">
          GIPHY 与 KLIPY 会在搜索界面显示来源标识；Tenor 主要保留给已经拥有旧 API Key 的用户。没有列出的服务可以放进“其他接口”。
        </p>
      </div>
    </div>
  )
}

