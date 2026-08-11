import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/TopBar'
import { db } from '../db/db'
import { isSpeechProviderReady, SPEECH_PROVIDER_INFO, speechProviderName } from '../lib/speechProviders'
import { stopSpeechPlayback } from '../lib/speechPlayer'
import { useSettingsStore } from '../store/useSettingsStore'

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function SpeechProviderListPage() {
  const navigate = useNavigate()
  const speechProvider = useSettingsStore((state) => state.speechProvider)
  const speechProviders = useSettingsStore((state) => state.speechProviders)
  const setSettings = useSettingsStore((state) => state.setSettings)
  const stats = useLiveQuery(async () => {
    const rows = await db.speechCache.toArray()
    return { count: rows.length, bytes: rows.reduce((sum, row) => sum + row.size, 0) }
  }, [])
  const ready = isSpeechProviderReady({ speechProvider, speechProviders })

  async function clearCache() {
    if (!window.confirm('清除所有已生成语音？原文字消息不会受到影响。')) return
    stopSpeechPlayback()
    await db.speechCache.clear()
  }

  return (
    <div className="ui-page">
      <TopBar title="语音生成" showBack />
      <div className="ui-page-scroll">
        <section className="ui-page-intro"><p className="ui-page-kicker">当前语音服务</p><h1 className="ui-page-title">{speechProviderName(speechProvider)}</h1>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className={`mt-1 text-xs ${ready ? 'text-green-600' : 'text-gray-400'}`}>
                {ready ? '已就绪' : speechProvider === 'none' ? '未启用' : '还需完成配置'}
              </p>
            </div>
            {speechProvider !== 'none' && (
              <button type="button" onClick={() => setSettings({ speechProvider: 'none' })} className="rounded-lg bg-gray-100 px-3 py-2 text-xs text-gray-600">关闭</button>
            )}
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-gray-400">启用后，长按聊天中的文字消息即可生成语音。一次只使用一个服务，各家的配置会分别保留。</p>
        </section>

        <h2 className="ui-section-label">选择服务</h2><section className="ui-list-card">
          <div className="mt-1">
            {SPEECH_PROVIDER_INFO.map((item) => {
              const selected = speechProvider === item.id
              return (
                <button key={item.id} type="button" onClick={() => navigate(`/settings/speech-generation/${item.id}`)} className="ui-list-row">
                  <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-xs font-semibold ${selected ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'}`}>{item.id === 'doubao' ? '豆包' : 'MiMo'}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2"><p className="text-sm text-gray-900">{item.name}</p>{item.badge && <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">{item.badge}</span>}{selected && <span className="text-[10px] text-green-600">使用中</span>}</div>
                    <p className="mt-0.5 text-xs text-gray-400">{item.description}</p>
                  </div>
                  <span className="text-lg text-gray-300">›</span>
                </button>
              )
            })}
          </div>
        </section>

        <h2 className="ui-section-label">本机存储</h2><section className="ui-section-card">
          <div className="flex items-center justify-between gap-3">
            <div><p className="text-sm text-gray-900">本地语音缓存</p><p className="mt-1 text-xs text-gray-400">{stats ? `${stats.count} 条 · ${formatBytes(stats.bytes)}` : '正在统计…'}，最多约 100 MB</p></div>
            <button type="button" onClick={() => void clearCache()} disabled={!stats?.count} className="rounded-lg bg-gray-100 px-3 py-2 text-xs text-gray-600 disabled:opacity-40">清理</button>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-gray-400">缓存不会进入 Talk 备份；清理后仍可从原文字重新生成。</p>
        </section>
      </div>
    </div>
  )
}
