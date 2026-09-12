import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/TopBar'
import { imageProviderName, isImageProviderReady } from '../lib/mediaProviders'
import { generateRemoteImage, type GeneratedImageResult } from '../lib/remoteMedia'
import { friendlyConnectionError } from '../lib/connectionError'
import { useSettingsStore } from '../store/useSettingsStore'

export function DrawingToolPage() {
  const navigate = useNavigate()
  const settings = useSettingsStore()
  const [prompt, setPrompt] = useState('')
  const [result, setResult] = useState<GeneratedImageResult | null>(null)
  const [status, setStatus] = useState('')
  const [generating, setGenerating] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const ready = isImageProviderReady(settings)
  const providerName = imageProviderName(settings.imageProvider)

  useEffect(() => () => abortRef.current?.abort(), [])

  async function generate() {
    if (generating) {
      abortRef.current?.abort()
      setStatus('正在停止等待…')
      return
    }
    if (!ready) {
      setStatus('请先选择并配置一个图片生成服务。')
      return
    }
    if (!prompt.trim()) {
      setStatus('请输入本次绘图使用的提示词。')
      return
    }
    const controller = new AbortController()
    abortRef.current = controller
    setGenerating(true)
    setResult(null)
    setStatus('正在提交绘图任务…')
    try {
      const generated = await generateRemoteImage(settings, prompt.trim(), {
        signal: controller.signal,
        onProgress: (progress) => setStatus(progress.message),
      })
      if (!generated) throw new Error('接口已响应，但没有解析到图片')
      setResult(generated)
      setStatus('绘图完成。')
    } catch (error) {
      setStatus(error instanceof DOMException && error.name === 'AbortError'
        ? '已停止等待；服务端任务可能仍会继续执行。'
        : friendlyConnectionError(error, providerName))
    } finally {
      abortRef.current = null
      setGenerating(false)
    }
  }

  const urls = result?.urls?.length ? result.urls : result ? [result.url] : []

  return (
    <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[var(--ui-bg)]">
      <TopBar title="绘图工具" showBack />
      <div className="flex-1 overflow-y-auto pb-6">
        <section className="border-b border-[var(--ui-border-soft)] bg-[var(--ui-surface)] px-4 pb-5 pt-5">
          <p className="text-xs font-medium text-[var(--ui-text-3)]">当前绘图模型</p>
          <div className="mt-1 flex items-center justify-between gap-3">
            <h1 className="ui-font-display text-lg font-semibold text-[var(--ui-text)]">{providerName}</h1>
            <span className={`text-xs ${ready ? 'text-[var(--ui-success-ink)]' : 'text-[var(--ui-warning-ink)]'}`}>{ready ? '已就绪' : '待配置'}</span>
          </div>
          <button type="button" onClick={() => navigate('/settings/image-generation')} className="mt-3 text-xs text-[var(--ui-special-ink)]">切换或配置绘图模型 ›</button>
        </section>

        <section className="mx-4 mt-4 rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] px-4 py-4 shadow-[var(--ui-shadow)]">
          <label className="block">
            <span className="text-sm font-medium text-[var(--ui-text)]">提示词</span>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={6}
              placeholder="输入任意提示词，直接测试当前绘图模型"
              className="mt-3 w-full resize-y rounded-[var(--ui-radius-control)] border border-[var(--ui-border)] bg-[var(--ui-surface)] px-3 py-3 text-sm text-[var(--ui-text)] outline-none focus:border-[var(--ui-action)]"
            />
          </label>
          <button
            type="button"
            onClick={() => void generate()}
            disabled={!generating && (!ready || !prompt.trim())}
            className={`mt-3 w-full rounded-[var(--ui-radius-control)] py-3 text-sm text-[var(--ui-on-action)] disabled:opacity-45 ${generating ? 'bg-[var(--ui-danger)]' : 'bg-[var(--ui-action)]'}`}
          >
            {generating ? '停止等待' : '开始绘图'}
          </button>
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--ui-warning-ink)]">会真实调用当前图片服务，云端模型可能消耗额度。</p>
          {status && <p role="status" className="mt-3 text-xs leading-relaxed text-[var(--ui-text-2)]">{status}</p>}
        </section>

        {urls.length > 0 && (
          <section className="mx-4 mt-4 rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] px-4 py-4 shadow-[var(--ui-shadow)]">
            <h2 className="ui-font-display mb-3 text-sm font-semibold text-[var(--ui-text)]">绘图结果</h2>
            <div className={urls.length > 1 ? 'grid grid-cols-2 gap-2' : ''}>
              {urls.map((url, index) => <img key={`${index}:${url.slice(-24)}`} src={url} alt={`绘图结果 ${index + 1}`} className="max-h-[32rem] w-full rounded-xl bg-[var(--ui-surface-2)] object-contain" />)}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
