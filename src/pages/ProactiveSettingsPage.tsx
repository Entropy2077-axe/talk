import { TopBar } from '../components/TopBar'
import { useSettingsStore } from '../store/useSettingsStore'

const DAILY_CAP_MAX = 16 // slider position: 1-15 = real, 16 = ∞
const STORED_INFINITE = 999 // stored value for "infinite"

function SliderRow({
  label,
  desc,
  value,
  min,
  max,
  step,
  unit,
  infiniteAtMax,
  displayValue: customDisplay,
  onChange,
}: {
  label: string
  desc?: string
  value: number
  min: number
  max: number
  step: number
  unit: string
  infiniteAtMax?: boolean
  displayValue?: string
  onChange: (v: number) => void
}) {
  const displayValue = customDisplay ?? (infiniteAtMax && value >= max ? '∞' : `${value}${unit}`)
  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between">
        <span className="text-[14px] font-medium text-gray-800">{label}</span>
        <span className="text-sm text-gray-500">{displayValue}</span>
      </div>
      {desc && <p className="mt-0.5 text-[11px] text-gray-400">{desc}</p>}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value > max ? max : value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-2 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-gray-200 accent-[#aa3bff]"
      />
    </div>
  )
}

export function ProactiveSettingsPage() {
  const settings = useSettingsStore()
  const {
    proactiveDailyCap,
    proactiveProbability,
    proactiveSilenceThresholdMs,
    proactiveCooldownMs,
    proactiveMomentsMax,
    proactiveTickIntervalMs,
    setSettings,
  } = settings

  return (
    <div className="relative flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
      <TopBar title="自主行为设置" showBack />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-4 mt-3 overflow-hidden rounded-xl bg-white">
          <SliderRow
            label="每天主动聊天次数上限"
            desc="1~15次，拉到最右为∞不限制（会产生较多API费用）"
            value={proactiveDailyCap >= STORED_INFINITE ? DAILY_CAP_MAX : proactiveDailyCap}
            min={1}
            max={DAILY_CAP_MAX}
            step={1}
            unit="次"
            infiniteAtMax
            onChange={(v) => setSettings({ proactiveDailyCap: v >= DAILY_CAP_MAX ? STORED_INFINITE : v })}
          />
          <div className="border-t border-gray-50" />
          <SliderRow
            label="触发概率"
            desc="每次后台检查时 触发主动聊天的概率"
            value={Math.round(proactiveProbability * 100)}
            min={5}
            max={100}
            step={5}
            unit="%"
            onChange={(v) => setSettings({ proactiveProbability: v / 100 })}
          />
          <div className="border-t border-gray-50" />
          <SliderRow
            label="沉默阈值"
            desc="至少沉默多久才会考虑主动找你"
            value={Math.round(proactiveSilenceThresholdMs / (60 * 1000))}
            min={5}
            max={120}
            step={5}
            unit="分钟"
            onChange={(v) => setSettings({ proactiveSilenceThresholdMs: v * 60 * 1000 })}
          />
          <div className="border-t border-gray-50" />
          <SliderRow
            label="单人冷却时间"
            desc="同一个联系人多久内不会重复主动找你"
            value={Math.round(proactiveCooldownMs / (60 * 1000))}
            min={10}
            max={2880}
            step={10}
            unit="分钟"
            displayValue={`${Math.round(proactiveCooldownMs / (60 * 60 * 1000) * 10) / 10} 小时`}
            onChange={(v) => setSettings({ proactiveCooldownMs: v * 60 * 1000 })}
          />
          <div className="border-t border-gray-50" />
          <SliderRow
            label="每次朋友圈刷新数量"
            desc="后台定时刷新时 最多让几个联系人发朋友圈"
            value={proactiveMomentsMax}
            min={1}
            max={10}
            step={1}
            unit="人"
            onChange={(v) => setSettings({ proactiveMomentsMax: v })}
          />
          <div className="border-t border-gray-50" />
          <SliderRow
            label="后台刷新间隔"
            desc="后台定时器多久检查一次（影响朋友圈刷新和主动聊天的响应速度）"
            value={Math.round(proactiveTickIntervalMs / (60 * 1000))}
            min={1}
            max={30}
            step={1}
            unit="分钟"
            onChange={(v) => setSettings({ proactiveTickIntervalMs: v * 60 * 1000 })}
          />
        </div>

        <div className="mx-4 mt-6 mb-6">
          <button
            onClick={() =>
              setSettings({
                proactiveDailyCap: 3,
                proactiveProbability: 0.25,
                proactiveSilenceThresholdMs: 45 * 60 * 1000,
                proactiveCooldownMs: 6 * 60 * 60 * 1000,
                proactiveMomentsMax: 3,
                proactiveTickIntervalMs: 5 * 60 * 1000,
              })
            }
            className="w-full rounded-xl bg-white px-4 py-3 text-sm text-gray-500 active:bg-gray-50"
          >
            恢复默认
          </button>
        </div>
      </div>
    </div>
  )
}
