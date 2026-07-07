import { TopBar } from '../components/TopBar'
import { useSettingsStore } from '../store/useSettingsStore'

export function MoodSettingsPage() {
  const { moodExpiryMs, setSettings } = useSettingsStore()
  const minutes = Math.round(moodExpiryMs / (60 * 1000))

  return (
    <div className="relative flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
      <TopBar title="心情设置" showBack />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-4 mt-3 overflow-hidden rounded-xl bg-white">
          <div className="px-4 py-3">
            <div className="flex items-center justify-between">
              <span className="text-[14px] font-medium text-gray-800">心情持续时间</span>
              <span className="text-sm text-gray-500">{minutes} 分钟</span>
            </div>
            <p className="mt-0.5 text-[11px] text-gray-400">
              AI表达的心情（如开心、吃醋、生气）持续多久后自动消失
            </p>
            <input
              type="range"
              min={5}
              max={120}
              step={5}
              value={minutes}
              onChange={(e) => setSettings({ moodExpiryMs: Number(e.target.value) * 60 * 1000 })}
              className="mt-2 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-gray-200 accent-[#aa3bff]"
            />
          </div>
        </div>

        <div className="mx-4 mt-6 mb-6">
          <button
            onClick={() => setSettings({ moodExpiryMs: 30 * 60 * 1000 })}
            className="w-full rounded-xl bg-white px-4 py-3 text-sm text-gray-500 active:bg-gray-50"
          >
            恢复默认（30分钟）
          </button>
        </div>
      </div>
    </div>
  )
}
