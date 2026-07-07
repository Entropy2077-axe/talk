import { useState } from 'react'
import { TopBar } from '../components/TopBar'
import { useSettingsStore } from '../store/useSettingsStore'
import { ALL_MODULES, PARENT_MODULES, STANDALONE_MODULES, DEFAULT_ENABLED_MODULES } from '../features'

export function ModulesPage() {
  const enabledModules = useSettingsStore((s) => s.enabledModules)
  const setSettings = useSettingsStore((s) => s.setSettings)
  // Which parent accordions are expanded (all expanded by default).
  const [expanded, setExpanded] = useState<Record<string, boolean>>(
    () => Object.fromEntries(PARENT_MODULES.map((p) => [p.id, true])),
  )

  function toggle(id: string) {
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
    <div className="relative flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
      <TopBar title="模组" showBack />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-4 mt-3 space-y-3">
          <p className="text-xs text-gray-400">
            开启或关闭功能模组，关闭后对应功能和入口隐藏，不会引发报错
          </p>

          {/* Parent module accordions */}
          {PARENT_MODULES.map((parent) => {
            const kids = childrenOf(parent.id)
            if (kids.length === 0) return null
            const open = expanded[parent.id]
            const allOn = kids.every((k) => enabledModules.includes(k.id))
            const anyOn = kids.some((k) => enabledModules.includes(k.id))

            return (
              <div key={parent.id} className="overflow-hidden rounded-xl bg-white">
                <button
                  onClick={() => toggleExpand(parent.id)}
                  className="flex w-full items-center justify-between px-4 py-3.5"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-lg">{parent.icon}</span>
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
                    <path d="M9 5l7 7-7 7" stroke="#c7c7cc" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>

                {open && (
                  <div className="border-t border-gray-50">
                    {kids.map((mod) => {
                      const on = enabledModules.includes(mod.id)
                      return (
                        <div
                          key={mod.id}
                          className="flex items-center justify-between border-b border-gray-50 px-4 py-3 last:border-b-0"
                        >
                          <div className="flex items-center gap-3 pl-8">
                            <span className="text-base">{mod.icon}</span>
                            <div>
                              <p className="text-[14px] text-gray-800">{mod.name}</p>
                              <p className="mt-0.5 text-[11px] text-gray-400">{mod.description}</p>
                            </div>
                          </div>
                          <button
                            onClick={() => toggle(mod.id)}
                            className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors ${
                              on ? 'bg-[#07c160]' : 'bg-gray-200'
                            }`}
                          >
                            <span
                              className={`inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                                on ? 'translate-x-6' : 'translate-x-1'
                              }`}
                            />
                          </button>
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
            const on = enabledModules.includes(mod.id)
            return (
              <div
                key={mod.id}
                className="flex items-center justify-between rounded-xl bg-white px-4 py-3.5"
              >
                <div className="flex items-center gap-3">
                  <span className="text-lg">{mod.icon}</span>
                  <div>
                    <p className="text-[15px] font-medium text-gray-900">{mod.name}</p>
                    <p className="mt-0.5 text-xs text-gray-400">{mod.description}</p>
                  </div>
                </div>
                <button
                  onClick={() => toggle(mod.id)}
                  className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors ${
                    on ? 'bg-[#07c160]' : 'bg-gray-200'
                  }`}
                >
                  <span
                    className={`inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                      on ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
            )
          })}

          {ALL_MODULES.length === 0 && (
            <p className="py-8 text-center text-sm text-gray-400">暂无可用模组</p>
          )}
        </div>

        <div className="mx-4 mt-6 mb-6">
          <button
            onClick={() => setSettings({ enabledModules: DEFAULT_ENABLED_MODULES })}
            className="w-full rounded-xl bg-white px-4 py-3 text-sm text-gray-500 active:bg-gray-50"
          >
            恢复默认
          </button>
        </div>
      </div>
    </div>
  )
}
