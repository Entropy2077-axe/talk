import { TopBar } from '../components/TopBar'
import { useSettingsStore } from '../store/useSettingsStore'
import { useModuleEnabled } from '../features'

export function ValidatorSettingsPage() {
  const { validatorMode, setSettings } = useSettingsStore()
  const enabled = useModuleEnabled('validator')
  const isQuality = validatorMode === 'quality'

  return (
    <div className="relative flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
      <TopBar title="校验器" showBack />
      <div className="flex-1 overflow-y-auto">
        {!enabled && (
          <div className="mx-4 mt-3 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-700">
            ⚠️ 校验器模组已关闭，AI回复将不经校验直接使用，质量可能下降
          </div>
        )}

        <div className="mx-4 mt-3 overflow-hidden rounded-xl bg-white">
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-4">
            <div className="flex-1 pr-4">
              <p className="text-[15px] font-medium text-gray-900">检查逻辑（必选）</p>
              <p className="mt-0.5 text-xs text-gray-400">
                必审 AI 回复的前提和推论是否紧密：身份、记忆、地点、日程、心情、关系等不能松散乱接。
              </p>
            </div>
            <span className="shrink-0 rounded-full bg-[#07c160]/10 px-2.5 py-1 text-xs font-medium text-[#07c160]">
              已启用
            </span>
          </div>

          <div className="flex items-center justify-between px-4 py-4">
            <div className="flex-1 pr-4">
              <p className="text-[15px] font-medium text-gray-900">强制优化</p>
              <p className="mt-0.5 text-xs text-gray-400">
                先检查逻辑，再把合格或已修复的回复扔回主模型润色。质量更高，消耗更多 token。
              </p>
            </div>
            <button
              onClick={() => setSettings({ validatorMode: 'optimize' })}
              className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors ${
                !isQuality ? 'bg-[#07c160]' : 'bg-gray-200'
              }`}
            >
              <span
                className={`inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                  !isQuality ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>
        </div>

        <div className="mx-4 mt-6 mb-6">
          <button
            onClick={() => setSettings({ validatorMode: 'quality' })}
            className="w-full rounded-xl bg-white px-4 py-3 text-sm text-gray-500 active:bg-gray-50"
          >
            恢复默认
          </button>
        </div>
      </div>
    </div>
  )
}
