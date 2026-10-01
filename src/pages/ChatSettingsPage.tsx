import { useRef, useState } from 'react'

import { TopBar } from '../components/TopBar'

import { ImageCropper } from '../components/ImageCropper'
import { useSettingsStore } from '../store/useSettingsStore'

import { CHAT_PAGE_SIZE_OPTIONS, normalizeChatPageSize } from '../lib/chatPagination'
import { ToggleSwitch } from '../components/ToggleSwitch'

import { SettingsLinks } from '../components/SettingsMenu'
import { FullscreenControl } from '../components/FullscreenControl'
export function ChatSettingsPage() {

  const { animationsEnabled, chatBackground, chatPageSize, chatResponseTimeoutMs, topInsetAdjustmentPx, setSettings } = useSettingsStore()
  const backgroundInputRef = useRef<HTMLInputElement | null>(null)
  const [backgroundCropSrc, setBackgroundCropSrc] = useState('')
  const presetBackgrounds = ['#f4f4f6', '#f7f0e8', '#eef6f1', '#edf4ff', '#f5efff', '#fff3f0', '#f3f6e8', '#eef7f7']
  async function handleBackgroundImage(file: File) {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') setBackgroundCropSrc(reader.result)
    }
    reader.readAsDataURL(file)
  }

  return <div className="ui-page"><TopBar title="外观与聊天" showBack /><div className="ui-page-scroll pb-5"><h2 className="ui-section-label">外观</h2><SettingsLinks entries={[{ to: '/appearance', label: '软件风格', note: '主题与明暗模式', icon: '🎨' }]} /><FullscreenControl />
    <section className="ui-section-card ui-section-spaced">
      <h2 className="ui-section-title">背景与动效</h2>
      <div className="mb-3 flex items-center justify-between border-t border-[var(--ui-border-soft)] pt-3">
        <div>
          <p className="text-sm text-[var(--ui-text)]">界面动效</p>
          <p className="mt-0.5 text-[11px] text-[var(--ui-text-3)]">切换、提示与消息出现的轻量动画</p>
        </div>
        <ToggleSwitch
          checked={animationsEnabled ?? true}
          onChange={(checked) => setSettings({ animationsEnabled: checked })}
          ariaLabel="切换界面动效"
          size="sm"
          activeTone="dark"
        />
      </div>

      <label className="mb-1 block text-xs text-[var(--ui-text-3)]">聊天背景色</label>
      <div className="mb-2 flex flex-wrap gap-2">
        {presetBackgrounds.map((color) => (
          <button
            key={color}
            onClick={() => setSettings({ chatBackground: color })}
            aria-label={`应用背景色 ${color}`}
            className={`h-8 w-8 rounded-full border ${chatBackground === color ? 'border-[var(--ui-action)] ring-2 ring-[var(--ui-border)]' : 'border-[var(--ui-border)]'
              }`}
            style={{ backgroundColor: color }}
          />
        ))}
      </div>
      <div className="mb-2 flex gap-2">
        <input
          type="color"
          value={chatBackground && chatBackground.startsWith('#') ? chatBackground : '#ededed'}
          onChange={(e) => setSettings({ chatBackground: e.target.value })}
          className="h-10 w-14 rounded-lg border border-[var(--ui-border)] p-1"
        />
        <button
          onClick={() => backgroundInputRef.current?.click()}
          className="flex-1 rounded-lg bg-[var(--ui-surface-2)] py-2 text-sm text-[var(--ui-text-2)]"
        >
          上传背景图
        </button>
        <button
          onClick={() => setSettings({ chatBackground: '' })}
          className="rounded-lg bg-[var(--ui-surface-2)] px-3 py-2 text-sm text-[var(--ui-text-2)]"
        >
          默认
        </button>
      </div>
      <input
        ref={backgroundInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void handleBackgroundImage(file)
          if (backgroundInputRef.current) backgroundInputRef.current.value = ''
        }}
      />
      <p className="text-[11px] text-[var(--ui-text-3)]">背景只保存在本机，导出备份时会一起带走。</p>
    </section>
    <h2 className="ui-section-label">聊天</h2><section className="ui-section-card ui-section-spaced">
      <h2 className="ui-section-title">消息加载与等待</h2>
      <label className="mb-1 block text-sm text-[var(--ui-text)]" htmlFor="chat-page-size">每次加载消息条数</label>
      <p className="mb-2 text-[11px] leading-relaxed text-[var(--ui-text-3)]">打开聊天时先加载这么多条；滚动到顶部后，每次继续加载相同数量。默认 40 条。</p>
      <div className="flex items-center gap-2">
        <select
          id="chat-page-size"
          aria-label="每次加载消息条数"
          value={normalizeChatPageSize(chatPageSize)}
          onChange={(event) => setSettings({ chatPageSize: Number(event.target.value) })}
          className="min-w-0 flex-1 rounded-lg border border-[var(--ui-border)] px-3 py-2 text-sm"
        >
          {CHAT_PAGE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size} 条</option>)}
        </select>
        <button type="button" onClick={() => setSettings({ chatPageSize: 40 })} className="rounded-lg bg-[var(--ui-surface-2)] px-3 py-2 text-xs text-[var(--ui-text-2)]">恢复默认</button>
      </div>
      <div className="mt-4 border-t border-[var(--ui-border-soft)] pt-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm text-[var(--ui-text)]">回复等待超时</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--ui-text-3)]">超时会停止本轮生成，保留已显示的消息，并可手动重试。</p>
          </div>
          <ToggleSwitch
            checked={chatResponseTimeoutMs > 0}
            onChange={(checked) => setSettings({ chatResponseTimeoutMs: checked ? 60 * 1000 : 0 })}
            ariaLabel="切换回复等待超时"
            size="sm"
            activeTone="dark"
          />
        </div>
        {chatResponseTimeoutMs > 0 && (
          <label className="mt-3 block text-xs text-[var(--ui-text-3)]" htmlFor="chat-response-timeout">
            超时时间（秒）
            <input
              id="chat-response-timeout"
              aria-label="回复等待超时时间（秒）"
              type="number"
              min="5"
              max="600"
              step="1"
              value={Math.round(chatResponseTimeoutMs / 1000)}
              onChange={(event) => {
                const seconds = Number(event.target.value)
                if (!Number.isFinite(seconds)) return
                setSettings({ chatResponseTimeoutMs: Math.max(5, Math.min(600, Math.round(seconds))) * 1000 })
              }}
              className="mt-1.5 w-full rounded-lg border border-[var(--ui-border)] px-3 py-2 text-sm text-[var(--ui-text)]"
            />
          </label>
        )}
      </div>
    </section><details className="ui-section-card ui-section-spaced"><summary className="cursor-pointer text-sm text-[var(--ui-text)]">显示适配</summary>        <div className="mb-4">
      <div className="mb-2 flex items-center justify-between">
        <div><p className="text-sm text-[var(--ui-text)]">顶部显示区域</p><p className="text-xs text-[var(--ui-text-3)]">自动避开系统安全区，并额外向下微调</p></div>
        <span className="text-xs text-[var(--ui-text-3)]">+{topInsetAdjustmentPx ?? 0}px</span>
      </div>
      <input aria-label="顶部显示区域微调" type="range" min="0" max="80" step="1" value={topInsetAdjustmentPx ?? 0} onChange={(e) => setSettings({ topInsetAdjustmentPx: Number(e.target.value) })} className="w-full accent-[var(--ui-action)]" />
      <button type="button" onClick={() => setSettings({ topInsetAdjustmentPx: 0 })} className="mt-1 text-xs text-[var(--ui-text-3)]">恢复默认</button>
    </div>
    </details></div>{backgroundCropSrc && <ImageCropper src={backgroundCropSrc} aspectRatio={0.68} mode="frame" title="裁剪聊天背景" onCancel={() => setBackgroundCropSrc('')} onConfirm={(dataUrl) => { setSettings({ chatBackground: dataUrl }); setBackgroundCropSrc('') }} />}</div>
}
