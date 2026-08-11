import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/TopBar'
import { useSettingsStore } from '../store/useSettingsStore'

export function ExperienceModePage() {
  const navigate = useNavigate()
  const mode = useSettingsStore((state) => state.experienceMode)
  const setSettings = useSettingsStore((state) => state.setSettings)

  function choose(next: 'immersive' | 'free') {
    if (next === mode) return
    if (next === 'immersive') {
      setSettings({ experienceMode: 'immersive', adminModeEnabled: false })
    } else {
      setSettings({ experienceMode: 'free' })
    }
  }

  return (
    <div className="ui-page">
      <TopBar title="体验模式" showBack />
      <div className="ui-page-scroll px-4 py-4">
        <p className="ui-page-kicker">使用方式</p><h1 className="ui-page-title">你希望 Talk 更像真实聊天，还是创作工具？</h1><p className="ui-page-summary mb-4">切换模式不会删除联系人、聊天记录或原有模组配置。</p>
        <button onClick={() => choose('immersive')} className={`block w-full rounded-xl border p-4 text-left ${mode === 'immersive' ? 'border-[var(--ui-special)] bg-[var(--ui-special-soft)]' : 'border-gray-200 bg-white'}`}>
          <div className="flex items-center justify-between"><h2 className="text-base font-medium text-gray-900">沉浸模式</h2>{mode === 'immersive' && <span className="text-xs text-[var(--ui-special-ink)]">使用中</span>}</div>
          <p className="mt-2 text-sm leading-relaxed text-gray-600">把这里当成真实聊天软件。通过模糊条件寻找联系人，对方不保证秒回，并隐藏好感度、读心、内部意图和地点等系统信息。</p>
          <p className="mt-2 text-xs text-gray-400">强制开启更真实的回复 · 管理员模式关闭 · 仅使用“帮我找人”</p>
        </button>
        <button onClick={() => choose('free')} className={`mt-3 block w-full rounded-xl border p-4 text-left ${mode === 'free' ? 'border-[var(--ui-special)] bg-[var(--ui-special-soft)]' : 'border-gray-200 bg-white'}`}>
          <div className="flex items-center justify-between"><h2 className="text-base font-medium text-gray-900">自由模式</h2>{mode === 'free' && <span className="text-xs text-[var(--ui-special-ink)]">使用中</span>}</div>
          <p className="mt-2 text-sm leading-relaxed text-gray-600">自由寻找或精细塑造AI角色，可以查看和开启更多游戏化资料、模组与管理员调试能力。</p>
          <p className="mt-2 text-xs text-gray-400">帮我找人 · 精细创建（女娲模式）· 自由配置模组</p>
        </button>
        <button onClick={() => navigate('/modules')} className="mt-4 w-full rounded-xl bg-white py-3 text-sm text-gray-600">查看功能模组</button>
      </div>
    </div>
  )
}
