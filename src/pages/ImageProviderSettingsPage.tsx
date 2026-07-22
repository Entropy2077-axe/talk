import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { TopBar } from '../components/TopBar'
import {
  IMAGE_PROVIDER_INFO,
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
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const [preview, setPreview] = useState<GeneratedImageResult | null>(null)

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
        ? '请先填写地址并读取一个模型。'
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
          ? `连接成功，读取到 ${loaded.models.length} 个模型、${loaded.samplers.length} 个采样器。`
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
    const candidate = currentCandidate()
    if (!isImageProviderReady(candidate)) {
      activate()
      return
    }
    setGenerating(true)
    setStatus(null)
    setPreview(null)
    try {
      const result = await generateRemoteImage(candidate, 'a cute orange cat waving, expressive, clean composition')
      if (!result) throw new Error('接口已响应，但没有解析到图片')
      setPreview(result)
      setSettings({ imageProvider: provider })
      setStatus({ ok: true, text: `真实调用成功，并已启用 ${info.name}。` })
    } catch (error) {
      setStatus({ ok: false, text: friendlyConnectionError(error, info.name) })
    } finally {
      setGenerating(false)
    }
  }

  const modelOptions = options.models
  const samplerOptions = options.samplers
  const schedulerOptions = options.schedulers

  return (
    <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
      <TopBar title={info.name} showBack />
      <div className="flex-1 overflow-y-auto pb-6">
        <section className="mt-3 bg-white px-4 py-4">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-medium text-gray-900">{info.name}</h2>
              <p className="mt-1 text-xs leading-relaxed text-gray-400">{info.description}</p>
            </div>
            <span className={`shrink-0 rounded-full px-2 py-1 text-[11px] ${active ? 'bg-green-50 text-green-600' : 'bg-gray-100 text-gray-500'}`}>
              {active ? '使用中' : '未启用'}
            </span>
          </div>

          {provider === 'atlas' && (
            <div className="space-y-3">
              <label className="block">
                <span className={labelClass}>Atlas API Key</span>
                <input aria-label="Atlas API Key" type="password" value={providers.atlas.apiKey} onChange={(event) => updateProvider('atlas', { apiKey: event.target.value })} placeholder="粘贴 API Key" className={inputClass} />
              </label>
              <label className="block">
                <span className={labelClass}>模型</span>
                <select value={providers.atlas.model} onChange={(event) => updateProvider('atlas', { model: event.target.value })} className={inputClass}>
                  <option value="bytedance/seedream-v4">Seedream v4</option>
                  <option value="bytedance/seedream-v5.0-pro/text-to-image">Seedream v5 Pro</option>
                </select>
              </label>
              <label className="block">
                <span className={labelClass}>画面比例</span>
                <select value={providers.atlas.size} onChange={(event) => updateProvider('atlas', { size: event.target.value })} className={inputClass}>
                  <option value="1024*1024">1:1 方图</option>
                  <option value="1152*896">横图 4:3</option>
                  <option value="896*1152">竖图 3:4</option>
                  <option value="1536*1024">横图 3:2</option>
                  <option value="1024*1536">竖图 2:3</option>
                </select>
              </label>
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
              <label className="block">
                <span className={labelClass}>ComfyUI 地址</span>
                <input aria-label="ComfyUI 地址" value={providers.comfyui.baseUrl} onChange={(event) => updateProvider('comfyui', { baseUrl: event.target.value })} placeholder="http://127.0.0.1:8188" className={inputClass} />
              </label>
              <label className="block">
                <span className={labelClass}>Bearer Token（反向代理有鉴权时填写）</span>
                <input type="password" value={providers.comfyui.apiKey} onChange={(event) => updateProvider('comfyui', { apiKey: event.target.value })} placeholder="通常留空" className={inputClass} />
              </label>
              <button type="button" onClick={() => void loadOptions()} disabled={loadingOptions} className="w-full rounded-lg bg-gray-100 py-2.5 text-sm text-gray-700 disabled:opacity-50">
                {loadingOptions ? '读取中…' : '连接并读取模型 / 采样器'}
              </button>
              <OptionOrInput label="Checkpoint 模型" value={providers.comfyui.model} options={modelOptions} placeholder="先点击上方按钮读取" onChange={(value) => updateProvider('comfyui', { model: value })} />
              <label className="block">
                <span className={labelClass}>尺寸</span>
                <select
                  value={`${providers.comfyui.width}x${providers.comfyui.height}`}
                  onChange={(event) => {
                    const [width, height] = event.target.value.split('x').map(Number)
                    updateProvider('comfyui', { width, height })
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
              <div className="grid grid-cols-2 gap-2">
                <OptionOrInput label="采样器" value={providers.comfyui.sampler} options={samplerOptions} placeholder="euler" onChange={(value) => updateProvider('comfyui', { sampler: value })} />
                <OptionOrInput label="调度器" value={providers.comfyui.scheduler} options={schedulerOptions} placeholder="normal" onChange={(value) => updateProvider('comfyui', { scheduler: value })} />
              </div>
              <RangeField label="步数" value={providers.comfyui.steps} min={1} max={80} onChange={(value) => updateProvider('comfyui', { steps: value })} />
              <RangeField label="CFG" value={providers.comfyui.cfg} min={1} max={20} step={0.5} onChange={(value) => updateProvider('comfyui', { cfg: value })} />
              <label className="block">
                <span className={labelClass}>固定提示词前缀（可选）</span>
                <textarea value={providers.comfyui.promptPrefix} onChange={(event) => updateProvider('comfyui', { promptPrefix: event.target.value })} rows={2} className={inputClass} />
              </label>
              <label className="block">
                <span className={labelClass}>负面提示词</span>
                <textarea value={providers.comfyui.negativePrompt} onChange={(event) => updateProvider('comfyui', { negativePrompt: event.target.value })} rows={3} className={inputClass} />
              </label>
              <p className="text-[11px] leading-relaxed text-gray-400">应用会自动创建“加载模型 → 正负提示词 → KSampler → VAE 解码 → 保存图片”的基础工作流，并轮询历史结果。</p>
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

          <div className="mt-5 grid grid-cols-2 gap-2">
            <button type="button" onClick={activate} disabled={active} className="rounded-lg bg-gray-100 py-2.5 text-sm text-gray-700 disabled:opacity-50">
              {active ? '已启用' : '启用此服务'}
            </button>
            <button type="button" onClick={() => void generatePreview()} disabled={generating} className="rounded-lg bg-gray-900 py-2.5 text-sm text-white disabled:opacity-50">
              {generating ? '生成中…' : '生成测试图'}
            </button>
          </div>
          {(provider === 'novelai' || provider === 'comfyui' || provider === 'stable-diffusion') && (
            <button type="button" onClick={() => void testConnection()} disabled={testing} className="mt-2 w-full rounded-lg border border-gray-200 py-2.5 text-sm text-gray-600 disabled:opacity-50">
              {testing ? '验证中…' : provider === 'novelai' ? '只验证 Token（不生图）' : '只测试连接（不生图）'}
            </button>
          )}
          <p className="mt-2 text-[11px] leading-relaxed text-amber-600">“生成测试图”会真实调用接口，云端服务可能消耗额度。</p>
          {status && <p className={`mt-3 text-xs ${status.ok ? 'text-green-600' : 'text-red-500'}`}>{status.ok ? '✓ ' : '✕ '}{status.text}</p>}
        </section>

        {preview && (
          <section className="mt-3 bg-white px-4 py-4">
            <h2 className="mb-3 text-xs font-medium text-gray-400">实际调用结果</h2>
            <img src={preview.url} alt="生图测试结果" className="max-h-96 w-full rounded-xl bg-gray-50 object-contain" />
          </section>
        )}

        <button type="button" onClick={() => navigate('/settings/image-generation')} className="mx-4 mt-4 w-[calc(100%-2rem)] rounded-lg bg-white py-2.5 text-sm text-gray-600">
          返回服务列表
        </button>
      </div>
    </div>
  )
}
