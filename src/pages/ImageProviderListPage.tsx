import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/TopBar'
import {
  IMAGE_PROVIDER_INFO,
  imageProviderName,
  isImageProviderReady,
} from '../lib/mediaProviders'
import { useSettingsStore } from '../store/useSettingsStore'

export function ImageProviderListPage() {
  const navigate = useNavigate()
  const imageProvider = useSettingsStore((state) => state.imageProvider)
  const imageProviders = useSettingsStore((state) => state.imageProviders)
  const setSettings = useSettingsStore((state) => state.setSettings)
  const ready = isImageProviderReady({ imageProvider, imageProviders })

  return (
    <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
      <TopBar title="AI 图片生成" showBack />
      <div className="flex-1 overflow-y-auto pb-6">
        <section className="mt-3 bg-white px-4 py-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-900">当前服务</p>
              <p className={`mt-1 text-xs ${ready ? 'text-green-600' : 'text-gray-400'}`}>
                {imageProviderName(imageProvider)} · {ready ? '已就绪' : imageProvider === 'none' ? '未启用' : '还需完成配置'}
              </p>
            </div>
            {imageProvider !== 'none' && (
              <button type="button" onClick={() => setSettings({ imageProvider: 'none' })} className="rounded-lg bg-gray-100 px-3 py-2 text-xs text-gray-600">
                关闭
              </button>
            )}
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-gray-400">
            启用后，AI 联系人会在确实适合发图时给出完整英文提示词，应用再调用这里选中的服务。一次只启用一个服务，各服务参数会分别保留。
          </p>
        </section>

        <section className="mt-3 bg-white">
          <h2 className="px-4 pt-4 text-xs font-medium text-gray-400">选择服务</h2>
          <div className="mt-1">
            {IMAGE_PROVIDER_INFO.map((item) => {
              const selected = imageProvider === item.id
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => navigate(`/settings/image-generation/${item.id}`)}
                  className="flex w-full items-center gap-3 border-b border-gray-100 px-4 py-3 text-left last:border-0"
                >
                  <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-xs font-semibold ${selected ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'}`}>
                    {item.id === 'stable-diffusion' ? 'SD' : item.name.slice(0, 2)}
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

        <section className="mx-4 mt-4 rounded-xl bg-blue-50 px-3 py-3">
          <p className="text-xs font-medium text-blue-700">本地接口提示</p>
          <p className="mt-1 text-[11px] leading-relaxed text-blue-600">
            电脑浏览器可填 127.0.0.1；安卓手机要填电脑的局域网 IP，并让手机和电脑处于同一网络。APK 已为这两类本地 HTTP 接口保留兼容。
          </p>
        </section>
      </div>
    </div>
  )
}

