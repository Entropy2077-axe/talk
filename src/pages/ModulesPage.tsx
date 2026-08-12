import { useState } from 'react'
import { TopBar } from '../components/TopBar'
import { ToggleSwitch } from '../components/ToggleSwitch'
import { UiIcon } from '../components/UiIcon'
import { useSettingsStore } from '../store/useSettingsStore'
import { ALL_MODULES, PARENT_MODULES, STANDALONE_MODULES, DEFAULT_ENABLED_MODULES, isModuleAllowedInExperienceMode } from '../features'

export function ModulesPage() {
  const enabledModules = useSettingsStore((s) => s.enabledModules)
  const setSettings = useSettingsStore((s) => s.setSettings)
  const experienceMode = useSettingsStore((s) => s.experienceMode)
  // Which parent accordions are expanded (all expanded by default).
  const [expanded, setExpanded] = useState<Record<string, boolean>>(
    () => Object.fromEntries(PARENT_MODULES.map((p) => [p.id, true])),
  )

  function toggle(id: string) {
    if (!isModuleAllowedInExperienceMode(id, experienceMode) || (experienceMode === 'immersive' && id === 'realisticReplies')) return
    if (id === 'location' && enabledModules.includes('slg')) return
    if (id === 'slg') {
      if (enabledModules.includes('slg')) {
        const withoutSlg = enabledModules.filter((moduleId) => moduleId !== 'slg')
        const restored = useSettingsStore.getState().slgLocationWasEnabled
          ? Array.from(new Set([...withoutSlg, 'location']))
          : withoutSlg.filter((moduleId) => moduleId !== 'location')
        setSettings({ enabledModules: restored, slgLocationWasEnabled: undefined })
      } else {
        setSettings({
          enabledModules: Array.from(new Set([...enabledModules, 'location', 'slg'])),
          slgLocationWasEnabled: enabledModules.includes('location'),
        })
      }
      return
    }
    const next = enabledModules.includes(id)
      ? enabledModules.filter((m) => m !== id)
      : [...enabledModules, id]
    setSettings({ enabledModules: next })
  }

  function toggleExpand(parentId: string) {
    setExpanded((prev) => ({ ...prev, [parentId]: !prev[parentId] }))
  }

  const childrenOf = (parentId: string) =>
    ALL_MODULES.filter((m) => m.parentId === parentId)

  return (
    <div className="ui-page relative">
      <TopBar title="模组" showBack />

      <div className="ui-page-scroll">
        <header className="ui-page-intro">
          <p className="ui-page-kicker">功能组合</p>
          <h1 className="ui-page-title">已开启 {enabledModules.length} 个模组</h1>
          <p className="ui-page-summary">
            开启或关闭功能模组，关闭后对应功能和入口隐藏，不会引发报错
          </p>
        </header>
        <div className="mx-4 mt-3 space-y-3">

          {/* Parent module accordions */}
          {PARENT_MODULES.map((parent) => {
            const kids = childrenOf(parent.id)
            if (kids.length === 0) return null
            const open = expanded[parent.id]
            const allOn = kids.every((k) => enabledModules.includes(k.id))
            const anyOn = kids.some((k) => enabledModules.includes(k.id))

            return (
              <div key={parent.id} className="overflow-hidden rounded-[var(--ui-radius-card)] border border-[var(--ui-border)] bg-[var(--ui-surface)]">
                <button
                  onClick={() => toggleExpand(parent.id)}
                  className="flex w-full items-center justify-between px-4 py-3.5"
                >
                  <div className="flex items-center gap-3">
                    <UiIcon name={parent.icon} size={20} className="text-[var(--ui-special-ink)]" />
                    <div className="text-left">
                      <div className="flex items-center gap-2">
                        <p className="text-[15px] font-medium text-gray-900">{parent.name}</p>
                        {allOn ? (
                          <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] text-green-700">全部开启</span>
                        ) : anyOn ? (
                          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">部分开启</span>
                        ) : (
                          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">全部关闭</span>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-gray-400">{parent.description}</p>
                    </div>
                  </div>
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    className={`transition-transform ${open ? 'rotate-90' : ''}`}
                  >
                    <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>

                {open && (
                  <div className="border-t border-gray-50">
                    {kids.map((mod) => {
                      const locked = !isModuleAllowedInExperienceMode(mod.id, experienceMode) || (experienceMode === 'immersive' && mod.id === 'realisticReplies')
                      const on = experienceMode === 'immersive' && mod.id === 'realisticReplies' ? true : !locked && enabledModules.includes(mod.id)
                      return (
                        <div
                          key={mod.id}
                          className="flex items-center justify-between border-b border-gray-50 px-4 py-3 last:border-b-0"
                        >
                          <div className="flex items-center gap-3 pl-8">
                            <UiIcon name={mod.icon} size={18} className="text-[var(--ui-special-ink)]" />
                            <div>
                              <p className="text-[14px] text-gray-800">{mod.name}</p>
                              <p className="mt-0.5 text-[11px] text-gray-400">{mod.description}</p>
                              {locked && <p className="mt-0.5 text-[10px] text-amber-600">{mod.id === 'realisticReplies' ? '沉浸模式强制开启' : '沉浸模式不可用'}</p>}
                            </div>
                          </div>
                          <ToggleSwitch
                            checked={on}
                            onChange={() => toggle(mod.id)}
                            ariaLabel={`${on ? '关闭' : '开启'}${mod.name}`}
                          />
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}

          {/* Standalone modules (no parent) */}
          {STANDALONE_MODULES.map((mod) => {
            const forcedBySlg = mod.id === 'location' && enabledModules.includes('slg')
            const locked = forcedBySlg || !isModuleAllowedInExperienceMode(mod.id, experienceMode) || (experienceMode === 'immersive' && mod.id === 'realisticReplies')
            const on = forcedBySlg || (experienceMode === 'immersive' && mod.id === 'realisticReplies') ? true : !locked && enabledModules.includes(mod.id)
            return (
              <div
                key={mod.id}
                className="flex items-center justify-between rounded-[var(--ui-radius-card)] border border-[var(--ui-border)] bg-[var(--ui-surface)] px-4 py-3.5"
              >
                <div className="flex items-center gap-3">
                  <UiIcon name={mod.icon} size={20} className="text-[var(--ui-special-ink)]" />
                  <div>
                    <p className="text-[15px] font-medium text-gray-900">{mod.name}</p>
                    <p className="mt-0.5 text-xs text-gray-400">{mod.description}</p>
                    {locked && <p className="mt-0.5 text-[10px] text-amber-600">{forcedBySlg ? '虚拟人生 SLG 模式强制开启' : mod.id === 'realisticReplies' ? '沉浸模式强制开启' : '沉浸模式不可用'}</p>}
                  </div>
                </div>
                <ToggleSwitch
                  checked={on}
                  onChange={() => toggle(mod.id)}
                  ariaLabel={`${on ? '关闭' : '开启'}${mod.name}`}
                />
              </div>
            )
          })}

          {ALL_MODULES.length === 0 && (
            <div className="ui-empty-state ui-section-flush"><p>暂无可用模组</p></div>
          )}
        </div>

        <div className="mx-4 mb-2 mt-6">
          <button
            onClick={() => setSettings({ enabledModules: DEFAULT_ENABLED_MODULES })}
            className="ui-secondary-action"
          >
            恢复默认
          </button>
        </div>
      </div>
    </div>
  )
}
