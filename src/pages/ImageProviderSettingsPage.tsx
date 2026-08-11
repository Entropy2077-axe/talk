import { useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { TopBar } from '../components/TopBar'
import {
  ATLAS_IMAGE_MODEL_PRESETS,
  IMAGE_PROVIDER_INFO,
  atlasImageModelPreset,
  isImageProviderReady,
} from '../lib/mediaProviders'
import {
  generateRemoteImage,
  loadImageProviderOptions,
  testImageProviderConnection,
  type GeneratedImageResult,
  type ImageProviderOptions,
} from '../lib/remoteMedia'
import { useSettingsStore } from '../store/useSettingsStore'
import type { ImageProviderId, ImageProvidersSettings } from '../types'
import { friendlyConnectionError } from '../lib/connectionError'
import {
  analyzeComfyWorkflow,
  detectComfyWorkflowBindings,
  getComfyWorkflowBindingOptions,
  validateComfyWorkflow,
  type ComfyBindingKind,
  type ComfyInputBinding,
  type ComfyWorkflow,
} from '../lib/comfyWorkflow'

const inputClass = 'w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-gray-400'
const labelClass = 'mb-1 block text-xs text-gray-500'
const emptyOptions: ImageProviderOptions = { models: [], samplers: [], schedulers: [] }

function isKnownProvider(value: string | undefined): value is Exclude<ImageProviderId, 'none'> {
  return IMAGE_PROVIDER_INFO.some((item) => item.id === value)
}

function RangeField(props: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center justify-between text-xs text-gray-500">
        <span>{props.label}</span>
        <span>{props.value}</span>
      </span>
      <input
        aria-label={props.label}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        onChange={(event) => props.onChange(Number(event.target.value))}
        className="w-full accent-gray-900"
      />
    </label>
  )
}

function OptionOrInput(props: {
  label: string
  value: string
  options: string[]
  placeholder: string
  onChange: (value: string) => void
  allowEmpty?: boolean
}) {
  const choices = Array.from(new Set([...(props.allowEmpty ? [''] : []), props.value, ...props.options])).filter((value, index) => value || props.allowEmpty || index > 0)
  return (
    <label className="block">
      <span className={labelClass}>{props.label}</span>
      {props.options.length > 0 ? (
        <select value={props.value} onChange={(event) => props.onChange(event.target.value)} className={inputClass}>
          {props.allowEmpty && <option value="">跟随当前服务设置</option>}
          {choices.filter(Boolean).map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      ) : (
        <input value={props.value} onChange={(event) => props.onChange(event.target.value)} placeholder={props.placeholder} className={inputClass} />
      )}
    </label>
  )
}

function ComfyBindingSelect(props: {
  label: string
  kind: ComfyBindingKind
  workflow: ComfyWorkflow
  value?: ComfyInputBinding
  required?: boolean
  onChange: (value: ComfyInputBinding | undefined) => void
}) {
  const options = getComfyWorkflowBindingOptions(props.workflow, props.kind)
  const encoded = props.value ? `${props.value.nodeId}\u0000${props.value.inputName}` : ''
  return (
    <label className="block">
      <span className={labelClass}>{props.label}{props.required ? '（必选）' : ''}</span>
      <select
        value={encoded}
        onChange={(event) => {
          if (!event.target.value) { props.onChange(undefined); return }
          const [nodeId, inputName] = event.target.value.split('\u0000')
          props.onChange({ nodeId, inputName })
        }}
        className={inputClass}
      >
        <option value="">{options.length ? '不映射 / 保留工作流原值' : '没有识别到可用字段'}</option>
        {options.map((option) => (
          <option key={`${option.nodeId}:${option.inputName}`} value={`${option.nodeId}\u0000${option.inputName}`}>
            {option.title} · {option.inputName}
          </option>
        ))}
      </select>
    </label>
  )
}

function OverrideToggle(props: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-3 py-1 text-xs text-gray-600">
      <span>{props.label}</span>
      <input type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} className="h-4 w-4 accent-gray-900" />
    </label>
  )
}

export function ImageProviderSettingsPage() {
  const navigate = useNavigate()
  const { providerId } = useParams()
  const activeProvider = useSettingsStore((state) => state.imageProvider)
  const providers = useSettingsStore((state) => state.imageProviders)
  const setSettings = useSettingsStore((state) => state.setSettings)
  const [options, setOptions] = useState<ImageProviderOptions>(emptyOptions)
  const [loadingOptions, setLoadingOptions] = useState(false)
  const [testing, setTesting] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [atlasCustomMode, setAtlasCustomMode] = useState(
    () => !atlasImageModelPreset(useSettingsStore.getState().imageProviders.atlas.model),
  )
  const [status, setStatus] = useState<{ ok: boolean; text: string; pending?: boolean } | null>(null)
  const [preview, setPreview] = useState<GeneratedImageResult | null>(null)
  const [, setPendingPreviewUrls] = useState<Set<string>>(new Set())
  const [testPrompt, setTestPrompt] = useState('a cute orange cat waving, expressive, clean composition')
  const workflowInputRef = useRef<HTMLInputElement | null>(null)
  const generateAbortRef = useRef<AbortController | null>(null)

  async function importComfyWorkflow(file: File) {
    try {
      const workflow = validateComfyWorkflow(JSON.parse(await file.text()))
      updateProvider('comfyui', {
        workflowMode: 'custom',
        workflow,
        workflowFileName: file.name,
        workflowBindings: detectComfyWorkflowBindings(workflow),
        workflowOverrides: {
          negativePrompt: false,
          seed: true,
          steps: false,
          cfg: false,
          sampler: false,
          scheduler: false,
          width: false,
          height: false,
        },
      })
      const analysis = analyzeComfyWorkflow(workflow)
      setStatus({ ok: true, text: `已导入 ${file.name}：${analysis.nodeCount} 个节点、${analysis.outputNodes.length} 个图片输出。请检查下方字段映射。` })
    } catch (error) {
      setStatus({ ok: false, text: error instanceof Error ? error.message : String(error) })
    } finally {
      if (workflowInputRef.current) workflowInputRef.current.value = ''
    }
  }

  if (!isKnownProvider(providerId)) {
    return (
      <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
        <TopBar title="图片接口" showBack />
        <div className="p-4 text-sm text-gray-500">这个服务不存在。</div>
      </div>
    )
  }

  const provider = providerId
  const info = IMAGE_PROVIDER_INFO.find((item) => item.id === provider)!

  function updateProvider<K extends keyof ImageProvidersSettings>(
    key: K,
    patch: Partial<ImageProvidersSettings[K]>,
  ) {
    const current = useSettingsStore.getState().imageProviders
    setSettings({
      imageProviders: {
        ...current,
        [key]: { ...current[key], ...patch },
      },
    })
    setStatus(null)
    setPreview(null)
  }

  function currentCandidate() {
    const state = useSettingsStore.getState()
    return {
      imageProvider: provider,
      imageProviders: state.imageProviders,
    }
  }

  const configured = isImageProviderReady({ imageProvider: provider, imageProviders: providers })
  const active = activeProvider === provider

  function activate() {
    if (!configured) {
      const hint = provider === 'comfyui'
        ? providers.comfyui.workflowMode === 'custom' ? '请填写地址并导入 API Format 工作流。' : '请填写地址并选择一个 Checkpoint 模型。'
        : provider === 'stable-diffusion' || provider === 'custom'
          ? '请先填写接口地址。'
          : '请先填写 API Key。'
      setStatus({ ok: false, text: hint })
      return
    }
    setSettings({ imageProvider: provider })
    setStatus({ ok: true, text: `${info.name} 已启用。` })
  }

  async function loadOptions() {
    setLoadingOptions(true)
    setStatus(null)
    try {
      const candidate = currentCandidate()
      const loaded = await loadImageProviderOptions(candidate, provider)
      setOptions(loaded)
      if (provider === 'comfyui' && loaded.models.length > 0 && !candidate.imageProviders.comfyui.model) {
        updateProvider('comfyui', { model: loaded.models[0] })
      }
      setStatus({
        ok: true,
        text: provider === 'comfyui' || provider === 'stable-diffusion'
          ? provider === 'comfyui'
            ? `连接成功，读取到 ${loaded.nodeTypes?.length ?? 0} 种节点、${loaded.models.length} 个模型、${loaded.samplers.length} 个采样器。`
            : `连接成功，读取到 ${loaded.models.length} 个模型、${loaded.samplers.length} 个采样器。`
          : '预设选项已载入。',
      })
    } catch (error) {
      setStatus({ ok: false, text: friendlyConnectionError(error, info.name) })
    } finally {
      setLoadingOptions(false)
    }
  }

  async function testConnection() {
    setTesting(true)
    setStatus(null)
    try {
      const text = await testImageProviderConnection(currentCandidate())
      setStatus({ ok: true, text })
    } catch (error) {
      setStatus({ ok: false, text: friendlyConnectionError(error, info.name) })
    } finally {
      setTesting(false)
    }
  }

  async function generatePreview() {
    if (generating) {
      generateAbortRef.current?.abort()
      setStatus({ ok: false, text: '正在停止等待…' })
      return
    }
    const candidate = currentCandidate()
    if (!isImageProviderReady(candidate)) {
      activate()
      return
    }
    setGenerating(true)
    setStatus(null)
    setPreview(null)
    setPendingPreviewUrls(new Set())
    const controller = new AbortController()
    generateAbortRef.current = controller
    try {
      const result = await generateRemoteImage(candidate, testPrompt.trim() || 'a cute orange cat waving', {
        signal: controller.signal,
        onProgress: (progress) => setStatus({ ok: true, pending: true, text: progress.message }),
      })
      if (!result) throw new Error('接口已响应，但没有解析到图片')
      setPreview(result)
      setPendingPreviewUrls(new Set(result.urls?.length ? result.urls : [result.url]))
      setSettings({ imageProvider: provider })
      setStatus({ ok: true, pending: true, text: '图片文件已收到，正在验证是否能正常显示…' })
    } catch (error) {
      setStatus({ ok: false, text: error instanceof DOMException && error.name === 'AbortError' ? '已停止等待；ComfyUI 队列中的任务可能仍会继续执行。' : friendlyConnectionError(error, info.name) })
    } finally {
      generateAbortRef.current = null
      setGenerating(false)
    }
  }

  const modelOptions = options.models
  const samplerOptions = options.samplers
  const schedulerOptions = options.schedulers
  const atlasPreset = atlasImageModelPreset(providers.atlas.model)
  const atlasSizes = atlasPreset?.sizes ?? ['1024*1024', '1152*896', '896*1152', '1536*1024', '1024*1536']
  const comfyWorkflow = providers.comfyui.workflowMode === 'custom' && providers.comfyui.workflow
    ? providers.comfyui.workflow as ComfyWorkflow
    : undefined
  const comfyAnalysis = comfyWorkflow ? analyzeComfyWorkflow(comfyWorkflow) : undefined
  const missingComfyNodes = comfyAnalysis && options.nodeTypes
    ? comfyAnalysis.nodeTypes.filter((nodeType) => !options.nodeTypes!.includes(nodeType))
    : []

  function updateComfyBinding(key: ComfyBindingKind, value: ComfyInputBinding | undefined) {
    updateProvider('comfyui', {
      workflowBindings: { ...(providers.comfyui.workflowBindings ?? {}), [key]: value },
    })
  }

  function confirmPreviewLoaded(url: string) {
    setPendingPreviewUrls((current) => {
      if (!current.has(url)) return current
      const next = new Set(current)
      next.delete(url)
      if (next.size === 0) setStatus({ ok: true, text: `真实调用成功，图片已验证可显示，并已启用 ${info.name}。` })
      return next
    })
  }

  function reportPreviewLoadFailure() {
    setPreview(null)
    setPendingPreviewUrls(new Set())
    setStatus({ ok: false, text: '图片任务已完成，但浏览器无法显示返回的图片文件。' })
  }

  function updateComfyOverride(key: keyof ImageProvidersSettings['comfyui']['workflowOverrides'], value: boolean) {
    updateProvider('comfyui', {
      workflowOverrides: { ...providers.comfyui.workflowOverrides, [key]: value },
    })
  }

  return (
    <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[var(--ui-bg)]">
      <TopBar title={info.name} showBack />
      <div className="flex-1 overflow-y-auto pb-6">
        <section className="border-b border-[var(--ui-border-soft)] bg-[var(--ui-surface)] px-4 pb-4 pt-5">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-[var(--ui-text-3)]">图片生成服务</p>
              <h1 className="ui-font-display mt-1 text-lg font-semibold text-[var(--ui-text)]">{info.name}</h1>
              <p className="mt-1 text-xs leading-relaxed text-gray-400">{info.description}</p>
            </div>
            <span className={`shrink-0 rounded-full px-2 py-1 text-[11px] ${active ? 'bg-green-50 text-green-600' : 'bg-gray-100 text-gray-500'}`}>
              {active ? '使用中' : '未启用'}
            </span>
          </div>
          <div className="mb-5 grid grid-cols-2 gap-2">
            <button type="button" onClick={activate} disabled={active} className="rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-2)] py-2.5 text-sm text-[var(--ui-text-2)] disabled:opacity-50">{active ? '已启用' : '启用此服务'}</button>
            <button type="button" onClick={() => void generatePreview()} className={`rounded-[var(--ui-radius-control)] py-2.5 text-sm text-[var(--ui-on-action)] ${generating ? 'bg-[var(--ui-danger)]' : 'bg-[var(--ui-action)]'}`}>{generating ? '停止等待' : '生成测试图'}</button>
          </div>
          {(provider === 'novelai' || provider === 'comfyui' || provider === 'stable-diffusion') && <button type="button" onClick={() => void testConnection()} disabled={testing} className="mb-2 w-full rounded-[var(--ui-radius-control)] border border-[var(--ui-border)] py-2.5 text-sm text-[var(--ui-text-2)] disabled:opacity-50">{testing ? '验证中…' : provider === 'novelai' ? '只验证 Token（不生图）' : '只测试连接（不生图）'}</button>}
          <p className="mb-4 text-[11px] leading-relaxed text-[var(--ui-warning-ink)]">“生成测试图”会真实调用接口，云端服务可能消耗额度。</p>
          {status && <p className={`mb-4 text-xs ${status.pending ? 'text-[var(--ui-warning-ink)]' : status.ok ? 'text-[var(--ui-success-ink)]' : 'text-[var(--ui-danger-ink)]'}`}>{status.pending ? '… ' : status.ok ? '✓ ' : '✕ '}{status.text}</p>}
          <div className="mb-4 border-t border-[var(--ui-border-soft)] pt-4"><h2 className="ui-font-display text-sm font-semibold text-[var(--ui-text)]">连接与生成参数</h2><p className="mt-1 text-[11px] text-[var(--ui-text-3)]">先填写服务需要的连接信息，再按需调整模型和工作流。</p></div>

          {provider === 'atlas' && (
            <div className="space-y-3">
              <label className="block">
                <span className={labelClass}>Atlas API Key</span>
                <input aria-label="Atlas API Key" type="password" value={providers.atlas.apiKey} onChange={(event) => updateProvider('atlas', { apiKey: event.target.value })} placeholder="粘贴 API Key" className={inputClass} />
              </label>
              <label className="block">
                <span className={labelClass}>模型</span>
                <select
                  value={atlasCustomMode || !atlasPreset ? '__custom__' : providers.atlas.model}
                  onChange={(event) => {
                    const model = event.target.value
                    if (model === '__custom__') {
                      setAtlasCustomMode(true)
                      updateProvider('atlas', { model: '' })
                      return
                    }
                    const preset = atlasImageModelPreset(model)
                    setAtlasCustomMode(false)
                    updateProvider('atlas', {
                      model,
                      ...(preset && preset.includeSize !== false && !preset.sizes.includes(providers.atlas.size)
                        ? { size: preset.defaultSize }
                        : {}),
                    })
                  }}
                  className={inputClass}
                >
                  {ATLAS_IMAGE_MODEL_PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.id}>{preset.name} · {preset.badge}</option>
                  ))}
                  <option value="__custom__">自定义模型 ID…</option>
                </select>
              </label>
              {(atlasCustomMode || !atlasPreset) && (
                <label className="block">
                  <span className={labelClass}>自定义模型 ID</span>
                  <input
                    value={providers.atlas.model}
                    onChange={(event) => updateProvider('atlas', { model: event.target.value })}
                    placeholder="例如：provider/model-name"
                    className={inputClass}
                  />
                </label>
              )}
              {atlasPreset && (
                <div className="rounded-lg bg-gray-50 px-3 py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium text-gray-800">{atlasPreset.name}</span>
                    <span className="rounded-full bg-green-50 px-2 py-0.5 text-[11px] text-green-600">{atlasPreset.badge}</span>
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-gray-500">{atlasPreset.description}</p>
                  <p className="mt-1 break-all font-mono text-[10px] text-gray-400">{atlasPreset.id}</p>
                </div>
              )}
              {atlasPreset?.includeSize !== false && (
                <label className="block">
                  <span className={labelClass}>画面尺寸</span>
                  <select value={providers.atlas.size} onChange={(event) => updateProvider('atlas', { size: event.target.value })} className={inputClass}>
                    {atlasSizes.map((size) => <option key={size} value={size}>{size.replace('*', ' × ')}</option>)}
                  </select>
                </label>
              )}
              {atlasPreset?.includeSize === false && <p className="text-[11px] text-gray-400">该模型当前使用 Atlas 的默认输出尺寸。</p>}
              <label className="block">
                <span className={labelClass}>统一人物风格</span>
                <select value={providers.atlas.visualStyle} onChange={(event) => updateProvider('atlas', { visualStyle: event.target.value as ImageProvidersSettings['atlas']['visualStyle'] })} className={inputClass}>
                  <option value="asian-realistic">亚洲真人 · 自然手机照片</option>
                  <option value="european-realistic">欧洲真人 · 自然手机照片</option>
                  <option value="anime">二次元 · 现代动画插画</option>
                  <option value="custom">自定义风格</option>
                </select>
              </label>
              {providers.atlas.visualStyle === 'custom' && <label className="block"><span className={labelClass}>自定义统一风格（必填）</span><textarea required value={providers.atlas.customVisualStyle} onChange={(event) => updateProvider('atlas', { customVisualStyle: event.target.value })} rows={3} placeholder="例如：cinematic watercolor illustration, soft paper texture" className={inputClass} />{!providers.atlas.customVisualStyle.trim() && <span className="mt-1 block text-[11px] text-red-500">填写风格提示词后才能启用 Atlas 生图。</span>}</label>}
              <label className="block">
                <span className={labelClass}>固定提示词前缀（可选）</span>
                <textarea value={providers.atlas.promptPrefix} onChange={(event) => updateProvider('atlas', { promptPrefix: event.target.value })} rows={2} placeholder="例如：anime illustration, expressive" className={inputClass} />
              </label>
              <p className="text-[11px] leading-relaxed text-gray-400">任务提交和结果轮询已经内置，不需要自己填写 URL 或任务 ID。</p>
            </div>
          )}

          {provider === 'novelai' && (
            <div className="space-y-3">
              <label className="block">
                <span className={labelClass}>NovelAI Access Token</span>
                <input aria-label="NovelAI Access Token" type="password" value={providers.novelai.apiKey} onChange={(event) => updateProvider('novelai', { apiKey: event.target.value })} placeholder="粘贴 Token" className={inputClass} />
              </label>
              <OptionOrInput
                label="模型"
                value={providers.novelai.model}
                options={modelOptions.length > 0 ? modelOptions : ['nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated', 'nai-diffusion-4-full', 'nai-diffusion-4-curated-preview', 'nai-diffusion-3']}
                placeholder="模型 ID"
                onChange={(value) => updateProvider('novelai', { model: value })}
              />
              <label className="block">
                <span className={labelClass}>画面比例</span>
                <select
                  value={`${providers.novelai.width}x${providers.novelai.height}`}
                  onChange={(event) => {
                    const [width, height] = event.target.value.split('x').map(Number)
                    updateProvider('novelai', { width, height })
                  }}
                  className={inputClass}
                >
                  <option value="1024x1024">1:1 方图</option>
                  <option value="1216x832">横图</option>
                  <option value="832x1216">竖图</option>
                </select>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <OptionOrInput label="采样器" value={providers.novelai.sampler} options={samplerOptions.length > 0 ? samplerOptions : ['k_euler_ancestral', 'k_euler', 'k_dpmpp_2m', 'k_dpmpp_sde', 'k_dpmpp_2s_ancestral', 'k_dpm_fast', 'ddim']} placeholder="采样器" onChange={(value) => updateProvider('novelai', { sampler: value })} />
                <OptionOrInput label="调度器" value={providers.novelai.scheduler} options={schedulerOptions.length > 0 ? schedulerOptions : ['karras', 'native', 'exponential', 'polyexponential']} placeholder="调度器" onChange={(value) => updateProvider('novelai', { scheduler: value })} />
              </div>
              <RangeField label="步数" value={providers.novelai.steps} min={1} max={50} onChange={(value) => updateProvider('novelai', { steps: value })} />
              <RangeField label="提示词引导强度" value={providers.novelai.scale} min={1} max={15} step={0.5} onChange={(value) => updateProvider('novelai', { scale: value })} />
              <label className="block">
                <span className={labelClass}>固定提示词前缀（可选）</span>
                <textarea value={providers.novelai.promptPrefix} onChange={(event) => updateProvider('novelai', { promptPrefix: event.target.value })} rows={2} className={inputClass} />
              </label>
              <label className="block">
                <span className={labelClass}>负面提示词</span>
                <textarea value={providers.novelai.negativePrompt} onChange={(event) => updateProvider('novelai', { negativePrompt: event.target.value })} rows={3} className={inputClass} />
              </label>
              <p className="text-[11px] leading-relaxed text-gray-400">请求会按 NovelAI 官方格式发送，并自动解压返回的图片 ZIP。</p>
            </div>
          )}

          {provider === 'comfyui' && (
            <div className="space-y-3">
              <div className="rounded-[var(--ui-radius-card)] border border-blue-100 bg-blue-50 p-3">
                <p className="text-xs font-medium text-blue-800">① 连接运行 ComfyUI 的电脑</p>
                <p className="mt-1 text-[11px] leading-relaxed text-blue-700">
                  Talk 和 ComfyUI 在同一台电脑时可用 127.0.0.1；安卓手机要填写电脑的局域网 IP，例如 http://192.168.1.20:8188。
                </p>
                <details className="mt-2 text-[11px] text-blue-700">
                  <summary className="cursor-pointer font-medium">查看官方启动与排查方法</summary>
                  <div className="mt-2 space-y-1.5 leading-relaxed">
                    <p>ComfyUI 启动参数加入：<code className="break-all">--listen 0.0.0.0 --port 8188 --enable-cors-header</code></p>
                    <p>电脑运行 <code>ipconfig</code>，查找当前 Wi-Fi/以太网的 IPv4 地址。手机与电脑需处于同一网络。</p>
                    <p>仍然无法连接时，请检查 Windows 防火墙是否允许 ComfyUI/Python 的 8188 入站连接。不要把未鉴权的 8188 端口直接暴露到公网。</p>
                  </div>
                </details>
              </div>
              <label className="block">
                <span className={labelClass}>ComfyUI 服务地址</span>
                <input aria-label="ComfyUI 地址" value={providers.comfyui.baseUrl} onChange={(event) => updateProvider('comfyui', { baseUrl: event.target.value })} placeholder="http://192.168.1.20:8188" className={inputClass} />
              </label>
              {/127\.0\.0\.1|localhost/i.test(providers.comfyui.baseUrl) && (
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-700">如果当前是在安卓手机中配置，这个地址会指向手机自己，请改为运行 ComfyUI 的电脑局域网 IP。</p>
              )}
              <div className="grid grid-cols-2 gap-2">
                <label>
                  <span className={labelClass}>鉴权方式</span>
                  <select value={providers.comfyui.authMode} onChange={(event) => updateProvider('comfyui', { authMode: event.target.value as ImageProvidersSettings['comfyui']['authMode'] })} className={inputClass}>
                    <option value="none">无鉴权（本地默认）</option>
                    <option value="bearer">Bearer Token</option>
                    <option value="x-api-key">X-API-Key</option>
                  </select>
                </label>
                <label>
                  <span className={labelClass}>等待超时</span>
                  <select value={providers.comfyui.timeoutSeconds} onChange={(event) => updateProvider('comfyui', { timeoutSeconds: Number(event.target.value) })} className={inputClass}>
                    <option value={120}>2 分钟</option>
                    <option value={300}>5 分钟</option>
                    <option value={600}>10 分钟</option>
                    <option value={1200}>20 分钟</option>
                  </select>
                </label>
              </div>
              {providers.comfyui.authMode !== 'none' && (
                <label className="block">
                  <span className={labelClass}>{providers.comfyui.authMode === 'x-api-key' ? 'X-API-Key' : 'Bearer Token'}</span>
                  <input type="password" value={providers.comfyui.apiKey} onChange={(event) => updateProvider('comfyui', { apiKey: event.target.value })} placeholder="反向代理或兼容服务需要时填写" className={inputClass} />
                </label>
              )}
              <button type="button" onClick={() => void loadOptions()} disabled={loadingOptions} className="w-full rounded-lg bg-gray-100 py-2.5 text-sm text-gray-700 disabled:opacity-50">
                {loadingOptions ? '读取中…' : '连接并读取节点 / 模型 / 采样器'}
              </button>

              <div className="rounded-[var(--ui-radius-card)] border border-[var(--ui-border)] bg-[var(--ui-surface-2)] p-3">
                <p className="text-xs font-medium text-[var(--ui-text)]">② 选择工作流</p>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => updateProvider('comfyui', { workflowMode: 'basic' })} className={`rounded-[var(--ui-radius-control)] border px-3 py-2 text-xs ${providers.comfyui.workflowMode !== 'custom' ? 'border-[var(--ui-action)] text-[var(--ui-action)]' : 'border-[var(--ui-border)] text-[var(--ui-text-2)]'}`}>内置基础工作流</button>
                  <button type="button" onClick={() => workflowInputRef.current?.click()} className={`rounded-[var(--ui-radius-control)] border px-3 py-2 text-xs ${providers.comfyui.workflowMode === 'custom' ? 'border-[var(--ui-action)] text-[var(--ui-action)]' : 'border-[var(--ui-border)] text-[var(--ui-text-2)]'}`}>导入 API 工作流</button>
                </div>
                <input ref={workflowInputRef} type="file" accept=".json,application/json" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importComfyWorkflow(file) }} />
                {providers.comfyui.workflowMode === 'custom' && <p className="mt-2 break-all text-[11px] text-[var(--ui-text-3)]">{providers.comfyui.workflowFileName || '自定义工作流'} · 仅支持 ComfyUI API Format JSON</p>}
              </div>

              {providers.comfyui.workflowMode === 'basic' && (
                <div className="space-y-3">
                  <OptionOrInput label="Checkpoint 模型" value={providers.comfyui.model} options={modelOptions} placeholder="先点击上方按钮读取" onChange={(value) => updateProvider('comfyui', { model: value })} />
                  <p className="text-[11px] leading-relaxed text-gray-400">内置工作流适合传统 Checkpoint（SD 1.5 / 常规 SDXL）。Flux、ControlNet、LoRA 或自定义节点请在 ComfyUI 中搭好后导入 API Format JSON。</p>
                </div>
              )}

              {providers.comfyui.workflowMode === 'custom' && comfyWorkflow && comfyAnalysis && (
                <div className="space-y-3 rounded-[var(--ui-radius-card)] border border-[var(--ui-border)] p-3">
                  <div>
                    <p className="text-xs font-medium text-gray-800">③ 检查工作流映射</p>
                    <p className="mt-1 text-[11px] text-gray-500">{comfyAnalysis.nodeCount} 个节点 · {comfyAnalysis.nodeTypes.length} 种节点类型 · {comfyAnalysis.outputNodes.length} 个图片输出</p>
                  </div>
                  {missingComfyNodes.length > 0 && (
                    <p className="rounded-lg bg-red-50 px-3 py-2 text-[11px] leading-relaxed text-red-600">当前服务器缺少节点：{missingComfyNodes.slice(0, 12).join('、')}{missingComfyNodes.length > 12 ? ` 等 ${missingComfyNodes.length} 个` : ''}</p>
                  )}
                  <ComfyBindingSelect label="正面提示词" kind="positivePrompt" workflow={comfyWorkflow} value={providers.comfyui.workflowBindings?.positivePrompt} required onChange={(value) => updateComfyBinding('positivePrompt', value)} />
                  <ComfyBindingSelect label="负面提示词" kind="negativePrompt" workflow={comfyWorkflow} value={providers.comfyui.workflowBindings?.negativePrompt} onChange={(value) => updateComfyBinding('negativePrompt', value)} />
                  <label className="block">
                    <span className={labelClass}>最终图片输出节点（必选）</span>
                    <select value={providers.comfyui.workflowBindings?.outputNodeId ?? ''} onChange={(event) => updateProvider('comfyui', { workflowBindings: { ...(providers.comfyui.workflowBindings ?? {}), outputNodeId: event.target.value || undefined } })} className={inputClass}>
                      <option value="">自动选择第一个图片输出</option>
                      {comfyAnalysis.outputNodes.map((output) => <option key={output.nodeId} value={output.nodeId}>{output.title} · {output.classType}</option>)}
                    </select>
                  </label>
                  <details>
                    <summary className="cursor-pointer text-xs font-medium text-gray-700">高级参数映射与覆盖</summary>
                    <div className="mt-3 space-y-3">
                      {([
                        ['seed', 'Seed', '每次随机 Seed'],
                        ['steps', 'steps', '覆盖步数'],
                        ['cfg', 'CFG / guidance', '覆盖 CFG'],
                        ['sampler', 'sampler', '覆盖采样器'],
                        ['scheduler', 'scheduler', '覆盖调度器'],
                        ['width', 'width', '覆盖宽度'],
                        ['height', 'height', '覆盖高度'],
                      ] as const).map(([kind, label, toggleLabel]) => (
                        <div key={kind} className="rounded-lg bg-gray-50 p-2.5">
                          <OverrideToggle label={toggleLabel} checked={kind === 'seed' ? providers.comfyui.workflowOverrides.seed : providers.comfyui.workflowOverrides[kind]} onChange={(checked) => updateComfyOverride(kind, checked)} />
                          <div className="mt-2"><ComfyBindingSelect label={label} kind={kind} workflow={comfyWorkflow} value={providers.comfyui.workflowBindings?.[kind]} onChange={(value) => updateComfyBinding(kind, value)} /></div>
                        </div>
                      ))}
                      <OverrideToggle label="覆盖负面提示词" checked={providers.comfyui.workflowOverrides.negativePrompt} onChange={(checked) => updateComfyOverride('negativePrompt', checked)} />
                    </div>
                  </details>
                </div>
              )}

              {(providers.comfyui.workflowMode === 'basic' || providers.comfyui.workflowOverrides.width || providers.comfyui.workflowOverrides.height) && (
                <label className="block">
                  <span className={labelClass}>尺寸</span>
                  <select value={`${providers.comfyui.width}x${providers.comfyui.height}`} onChange={(event) => { const [width, height] = event.target.value.split('x').map(Number); updateProvider('comfyui', { width, height }) }} className={inputClass}>
                    <option value="512x512">512 × 512（省显存）</option><option value="768x768">768 × 768</option><option value="1024x1024">1024 × 1024</option><option value="1024x768">1024 × 768 横图</option><option value="768x1024">768 × 1024 竖图</option>
                  </select>
                </label>
              )}
              {(providers.comfyui.workflowMode === 'basic' || providers.comfyui.workflowOverrides.sampler || providers.comfyui.workflowOverrides.scheduler) && (
                <div className="grid grid-cols-2 gap-2">
                  <OptionOrInput label="采样器" value={providers.comfyui.sampler} options={samplerOptions} placeholder="euler" onChange={(value) => updateProvider('comfyui', { sampler: value })} />
                  <OptionOrInput label="调度器" value={providers.comfyui.scheduler} options={schedulerOptions} placeholder="normal" onChange={(value) => updateProvider('comfyui', { scheduler: value })} />
                </div>
              )}
              {(providers.comfyui.workflowMode === 'basic' || providers.comfyui.workflowOverrides.steps) && <RangeField label="步数" value={providers.comfyui.steps} min={1} max={80} onChange={(value) => updateProvider('comfyui', { steps: value })} />}
              {(providers.comfyui.workflowMode === 'basic' || providers.comfyui.workflowOverrides.cfg) && <RangeField label="CFG" value={providers.comfyui.cfg} min={1} max={20} step={0.5} onChange={(value) => updateProvider('comfyui', { cfg: value })} />}
              <label className="block">
                <span className={labelClass}>固定提示词前缀（可选）</span>
                <textarea value={providers.comfyui.promptPrefix} onChange={(event) => updateProvider('comfyui', { promptPrefix: event.target.value })} rows={2} className={inputClass} />
              </label>
              {(providers.comfyui.workflowMode === 'basic' || providers.comfyui.workflowOverrides.negativePrompt) && <label className="block">
                <span className={labelClass}>负面提示词</span>
                <textarea value={providers.comfyui.negativePrompt} onChange={(event) => updateProvider('comfyui', { negativePrompt: event.target.value })} rows={3} className={inputClass} />
              </label>}
              <label className="block">
                <span className={labelClass}>测试图提示词</span>
                <textarea value={testPrompt} onChange={(event) => setTestPrompt(event.target.value)} rows={3} placeholder="输入本次测试使用的英文提示词" className={inputClass} />
              </label>
              <p className="text-[11px] leading-relaxed text-gray-400">Talk 按 ComfyUI 官方流程提交 /prompt，使用 prompt_id 查询 /history，完成后通过 /view 读取图片。自定义工作流始终在克隆副本中注入参数，不会修改已保存的原始 JSON。</p>
            </div>
          )}

          {provider === 'stable-diffusion' && (
            <div className="space-y-3">
              <label className="block">
                <span className={labelClass}>WebUI / Forge 地址</span>
                <input aria-label="Stable Diffusion 地址" value={providers.stableDiffusion.baseUrl} onChange={(event) => updateProvider('stableDiffusion', { baseUrl: event.target.value })} placeholder="http://127.0.0.1:7860" className={inputClass} />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label>
                  <span className={labelClass}>用户名（可选）</span>
                  <input value={providers.stableDiffusion.username} onChange={(event) => updateProvider('stableDiffusion', { username: event.target.value })} className={inputClass} />
                </label>
                <label>
                  <span className={labelClass}>密码（可选）</span>
                  <input type="password" value={providers.stableDiffusion.password} onChange={(event) => updateProvider('stableDiffusion', { password: event.target.value })} className={inputClass} />
                </label>
              </div>
              <button type="button" onClick={() => void loadOptions()} disabled={loadingOptions} className="w-full rounded-lg bg-gray-100 py-2.5 text-sm text-gray-700 disabled:opacity-50">
                {loadingOptions ? '读取中…' : '连接并读取模型 / 采样器'}
              </button>
              <OptionOrInput label="模型" value={providers.stableDiffusion.model} options={modelOptions} placeholder="留空则使用 WebUI 当前模型" allowEmpty onChange={(value) => updateProvider('stableDiffusion', { model: value })} />
              <label className="block">
                <span className={labelClass}>尺寸</span>
                <select
                  value={`${providers.stableDiffusion.width}x${providers.stableDiffusion.height}`}
                  onChange={(event) => {
                    const [width, height] = event.target.value.split('x').map(Number)
                    updateProvider('stableDiffusion', { width, height })
                  }}
                  className={inputClass}
                >
                  <option value="512x512">512 × 512（省显存）</option>
                  <option value="768x768">768 × 768</option>
                  <option value="1024x1024">1024 × 1024</option>
                  <option value="1024x768">1024 × 768 横图</option>
                  <option value="768x1024">768 × 1024 竖图</option>
                </select>
              </label>
              <OptionOrInput label="采样器" value={providers.stableDiffusion.sampler} options={samplerOptions} placeholder="Euler a" onChange={(value) => updateProvider('stableDiffusion', { sampler: value })} />
              <RangeField label="步数" value={providers.stableDiffusion.steps} min={1} max={80} onChange={(value) => updateProvider('stableDiffusion', { steps: value })} />
              <RangeField label="CFG" value={providers.stableDiffusion.cfg} min={1} max={20} step={0.5} onChange={(value) => updateProvider('stableDiffusion', { cfg: value })} />
              <label className="block">
                <span className={labelClass}>固定提示词前缀（可选）</span>
                <textarea value={providers.stableDiffusion.promptPrefix} onChange={(event) => updateProvider('stableDiffusion', { promptPrefix: event.target.value })} rows={2} className={inputClass} />
              </label>
              <label className="block">
                <span className={labelClass}>负面提示词</span>
                <textarea value={providers.stableDiffusion.negativePrompt} onChange={(event) => updateProvider('stableDiffusion', { negativePrompt: event.target.value })} rows={3} className={inputClass} />
              </label>
              <p className="text-[11px] leading-relaxed text-gray-400">启动 A1111 时需要带 <code>--api --listen</code>；Forge 使用相同的 <code>/sdapi/v1/txt2img</code> 接口。</p>
            </div>
          )}

          {provider === 'custom' && (
            <div className="space-y-3">
              <label className="block">
                <span className={labelClass}>接口地址</span>
                <input aria-label="自定义图片接口地址" value={providers.custom.endpoint} onChange={(event) => updateProvider('custom', { endpoint: event.target.value })} placeholder="https://example.com/generate" className={inputClass} />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label>
                  <span className={labelClass}>请求方式</span>
                  <select value={providers.custom.method} onChange={(event) => updateProvider('custom', { method: event.target.value as 'GET' | 'POST' })} className={inputClass}>
                    <option value="POST">POST</option>
                    <option value="GET">GET</option>
                  </select>
                </label>
                <label>
                  <span className={labelClass}>鉴权方式</span>
                  <select value={providers.custom.authMode} onChange={(event) => updateProvider('custom', { authMode: event.target.value as ImageProvidersSettings['custom']['authMode'] })} className={inputClass}>
                    <option value="none">无</option>
                    <option value="bearer">Bearer</option>
                    <option value="x-api-key">X-API-Key</option>
                    <option value="query">api_key 参数</option>
                  </select>
                </label>
              </div>
              <label className="block">
                <span className={labelClass}>API Key（可选）</span>
                <input type="password" value={providers.custom.apiKey} onChange={(event) => updateProvider('custom', { apiKey: event.target.value })} placeholder="没有就留空" className={inputClass} />
              </label>
              {providers.custom.method === 'POST' && (
                <label className="block">
                  <span className={labelClass}>JSON 请求体</span>
                  <textarea value={providers.custom.bodyTemplate} onChange={(event) => updateProvider('custom', { bodyTemplate: event.target.value })} rows={6} className={`${inputClass} font-mono text-xs`} />
                </label>
              )}
              <label className="block">
                <span className={labelClass}>图片返回字段</span>
                <input value={providers.custom.responsePath} onChange={(event) => updateProvider('custom', { responsePath: event.target.value })} placeholder="例如 data.output.url；直接返回图片可留空" className={inputClass} />
              </label>
              <p className="text-[11px] leading-relaxed text-gray-400"><code>{'{prompt}'}</code> / <code>{'{query}'}</code> 会替换为 AI 生成的提示词，<code>{'{apiKey}'}</code> 会替换为 Key。</p>
            </div>
          )}

        </section>

        {preview && (
          <section className="mx-4 mt-3 rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] px-4 py-4 shadow-[var(--ui-shadow)]">
            <h2 className="ui-font-display mb-3 text-sm font-semibold text-[var(--ui-text)]">实际调用结果</h2>
            <div className={(preview.urls?.length ?? 1) > 1 ? 'grid grid-cols-2 gap-2' : ''}>
              {(preview.urls?.length ? preview.urls : [preview.url]).map((url, index) => (
                <img key={`${index}:${url.slice(-24)}`} src={url} alt={`生图测试结果 ${index + 1}`} onLoad={() => confirmPreviewLoaded(url)} onError={reportPreviewLoadFailure} className="max-h-96 w-full rounded-xl bg-gray-50 object-contain" />
              ))}
            </div>
            {(preview.urls?.length ?? 1) > 1 && <p className="mt-2 text-[11px] text-gray-400">工作流返回了 {preview.urls!.length} 张图片；聊天发送时暂取第一张。</p>}
          </section>
        )}

        <button type="button" onClick={() => navigate('/settings/image-generation')} className="mx-4 mt-4 w-[calc(100%-2rem)] rounded-lg bg-white py-2.5 text-sm text-gray-600">
          返回服务列表
        </button>
      </div>
    </div>
  )
}
