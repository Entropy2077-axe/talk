import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { unzipSync } from 'fflate'
import type {
  ApiAuthMode,
  AppSettings,
  ImageProviderId,
  StickerProviderId,
} from '../types'
import { isImageProviderReady, isStickerProviderReady } from './mediaProviders'

export interface RemoteStickerResult {
  url: string
  name?: string
  provider: Exclude<StickerProviderId, 'none'>
  trackingUrl?: string
}

export interface GeneratedImageResult {
  url: string
  caption?: string
  query?: string
  provider: Exclude<ImageProviderId, 'none'>
}

export interface ImageProviderOptions {
  models: string[]
  samplers: string[]
  schedulers: string[]
}

type ResponseKind = 'json' | 'text' | 'bytes' | 'auto'

interface MediaRequestOptions {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  data?: unknown
  responseKind?: ResponseKind
  timeoutMs?: number
}

interface MediaResponse {
  status: number
  data: unknown
  contentType: string
}

function trimBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

function joinedPrompt(prefix: string, prompt: string): string {
  return [prefix.trim(), prompt.trim()].filter(Boolean).join(', ')
}

function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const raw = value.includes(',') ? value.slice(value.indexOf(',') + 1) : value
  const binary = atob(raw)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function bytesToDataUrl(bytes: Uint8Array, contentType = 'image/png'): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return `data:${contentType || 'image/png'};base64,${btoa(binary)}`
}

function headerContentType(headers: unknown): string {
  if (!headers || typeof headers !== 'object') return ''
  const record = headers as Record<string, unknown>
  const value = record['content-type'] ?? record['Content-Type']
  return typeof value === 'string' ? value.toLowerCase() : ''
}

function parseTextPayload(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function mediaRequest(url: string, options: MediaRequestOptions = {}): Promise<MediaResponse> {
  const method = options.method ?? 'GET'
  const responseKind = options.responseKind ?? 'json'
  const headers = { Accept: 'application/json', ...(options.headers ?? {}) }
  const timeoutMs = options.timeoutMs ?? 180_000

  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.request({
      url,
      method,
      headers,
      data: options.data,
      responseType: responseKind === 'bytes' || responseKind === 'auto' ? 'arraybuffer' : responseKind,
      connectTimeout: 30_000,
      readTimeout: timeoutMs,
    })
    const contentType = headerContentType(response.headers)
    if (responseKind === 'bytes') {
      const bytes = typeof response.data === 'string' ? base64ToBytes(response.data) : new Uint8Array(response.data as ArrayBuffer)
      return { status: response.status, data: bytes, contentType }
    }
    if (responseKind === 'auto' && typeof response.data === 'string') {
      const bytes = base64ToBytes(response.data)
      if (contentType.startsWith('image/')) {
        return { status: response.status, data: bytesToDataUrl(bytes, contentType.split(';')[0]), contentType }
      }
      return { status: response.status, data: parseTextPayload(new TextDecoder().decode(bytes)), contentType }
    }
    return {
      status: response.status,
      data: responseKind === 'json' && typeof response.data === 'string' ? parseTextPayload(response.data) : response.data,
      contentType,
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: options.data === undefined ? undefined : JSON.stringify(options.data),
      signal: controller.signal,
    })
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
    if (responseKind === 'bytes') {
      return { status: response.status, data: new Uint8Array(await response.arrayBuffer()), contentType }
    }
    if (responseKind === 'text') return { status: response.status, data: await response.text(), contentType }
    if (responseKind === 'auto' && contentType.startsWith('image/')) {
      return {
        status: response.status,
        data: bytesToDataUrl(new Uint8Array(await response.arrayBuffer()), contentType.split(';')[0]),
        contentType,
      }
    }
    const text = await response.text()
    return { status: response.status, data: parseTextPayload(text), contentType }
  } finally {
    clearTimeout(timer)
  }
}

function ensureOk(response: MediaResponse, label: string): void {
  if (response.status >= 200 && response.status < 300) return
  const record = response.data && typeof response.data === 'object' ? response.data as Record<string, unknown> : undefined
  const detail = [record?.message, record?.error, record?.detail].find((value) => typeof value === 'string')
  throw new Error(`${label}返回 HTTP ${response.status}${detail ? `：${String(detail).slice(0, 180)}` : ''}`)
}

function imageUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text.startsWith('data:image/')) return text
  try {
    const parsed = new URL(text)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null
  } catch {
    return null
  }
}

function collectImageUrls(value: unknown, output: string[], seen = new Set<unknown>()): void {
  if (output.length >= 24 || value === null || seen.has(value)) return
  if (typeof value === 'string') {
    const found = imageUrl(value)
    if (found && !output.includes(found)) output.push(found)
    return
  }
  if (typeof value !== 'object') return
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach((item) => collectImageUrls(item, output, seen))
    return
  }
  const record = value as Record<string, unknown>
  for (const key of ['url', 'image', 'imageUrl', 'src', 'source', 'thumbnail', 'content']) {
    const found = imageUrl(record[key])
    if (found && !output.includes(found)) output.push(found)
  }
  for (const child of Object.values(record)) collectImageUrls(child, output, seen)
}

function getPath(payload: unknown, path: string): unknown {
  if (!path.trim()) return payload
  return path.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') return undefined
    const arrayIndex = Number(key)
    if (Array.isArray(current) && Number.isInteger(arrayIndex)) return current[arrayIndex]
    return (current as Record<string, unknown>)[key]
  }, payload)
}

function fillUrlTemplate(template: string, value: string, apiKey = ''): string {
  const encoded = encodeURIComponent(value)
  return template
    .replaceAll('{query}', encoded)
    .replaceAll('{prompt}', encoded)
    .replaceAll('{apiKey}', encodeURIComponent(apiKey))
}

function customHeaders(apiKey: string, authMode: ApiAuthMode): Record<string, string> {
  const key = apiKey.trim()
  if (!key) return {}
  if (authMode === 'bearer') return { Authorization: `Bearer ${key}` }
  if (authMode === 'x-api-key') return { 'X-API-Key': key }
  return {}
}

function appendQueryKey(endpoint: string, apiKey: string, authMode: ApiAuthMode): string {
  if (authMode !== 'query' || !apiKey.trim() || endpoint.includes('{apiKey}')) return endpoint
  const url = new URL(endpoint)
  url.searchParams.set('api_key', apiKey.trim())
  return url.toString()
}

function stickerResultsFromGeneric(
  payload: unknown,
  provider: Exclude<StickerProviderId, 'none'>,
  query: string,
  responsePath = '',
): RemoteStickerResult[] {
  const selected = getPath(payload, responsePath)
  const urls: string[] = []
  const direct = imageUrl(selected)
  if (direct) urls.push(direct)
  else collectImageUrls(selected, urls)
  if (urls.length === 0 && selected !== payload) collectImageUrls(payload, urls)
  return urls.map((url, index) => ({ url, name: `${query}-${index + 1}`, provider }))
}

export async function searchRemoteStickers(
  settings: Pick<AppSettings, 'stickerProvider' | 'stickerProviders'>,
  query: string,
): Promise<RemoteStickerResult[]> {
  if (!isStickerProviderReady(settings)) return []
  const provider = settings.stickerProvider
  const cleanQuery = query.trim().slice(0, 50)
  if (!cleanQuery || provider === 'none') return []

  if (provider === 'giphy') {
    const config = settings.stickerProviders.giphy
    const params = new URLSearchParams({
      api_key: config.apiKey.trim(),
      q: cleanQuery,
      limit: '20',
      rating: config.rating,
      lang: config.language || 'zh-CN',
      bundle: 'messaging_non_clips',
    })
    const response = await mediaRequest(`https://api.giphy.com/v1/stickers/search?${params}`)
    ensureOk(response, 'GIPHY')
    const data = (response.data as { data?: unknown[] })?.data
    if (!Array.isArray(data)) return []
    return data.flatMap((item): RemoteStickerResult[] => {
      if (!item || typeof item !== 'object') return []
      const record = item as Record<string, unknown>
      const images = record.images as Record<string, Record<string, unknown>> | undefined
      const url = imageUrl(images?.fixed_height_small?.url)
        ?? imageUrl(images?.fixed_height?.url)
        ?? imageUrl(images?.original?.url)
      if (!url) return []
      const analytics = record.analytics as Record<string, { url?: unknown }> | undefined
      return [{
        url,
        name: typeof record.title === 'string' && record.title.trim() ? record.title.trim() : cleanQuery,
        provider: 'giphy',
        trackingUrl: typeof analytics?.onsent?.url === 'string' ? analytics.onsent.url : undefined,
      }]
    })
  }

  if (provider === 'klipy' || provider === 'tenor') {
    const config = settings.stickerProviders[provider]
    const params = new URLSearchParams({
      key: config.apiKey.trim(),
      q: cleanQuery,
      limit: '20',
      contentfilter: config.contentFilter,
      locale: config.locale || 'zh_CN',
      searchfilter: 'sticker',
      media_filter: 'gif,tinygif,webp,tinywebp',
    })
    const host = provider === 'klipy' ? 'https://api.klipy.com' : 'https://tenor.googleapis.com'
    const response = await mediaRequest(`${host}/v2/search?${params}`)
    ensureOk(response, provider === 'klipy' ? 'KLIPY' : 'Tenor')
    const results = (response.data as { results?: unknown[] })?.results
    if (!Array.isArray(results)) return []
    return results.flatMap((item): RemoteStickerResult[] => {
      if (!item || typeof item !== 'object') return []
      const record = item as Record<string, unknown>
      const formats = record.media_formats as Record<string, { url?: unknown }> | undefined
      const url = imageUrl(formats?.tinygif?.url)
        ?? imageUrl(formats?.gif?.url)
        ?? imageUrl(formats?.tinywebp?.url)
        ?? imageUrl(formats?.webp?.url)
      if (!url) return []
      return [{
        url,
        name: typeof record.content_description === 'string' ? record.content_description : cleanQuery,
        provider,
      }]
    })
  }

  const config = settings.stickerProviders.custom
  let endpoint = fillUrlTemplate(config.endpoint, cleanQuery, config.apiKey)
  endpoint = appendQueryKey(endpoint, config.apiKey, config.authMode)
  const response = await mediaRequest(endpoint, {
    headers: customHeaders(config.apiKey, config.authMode),
    responseKind: 'auto',
  })
  ensureOk(response, '自定义表情包接口')
  return stickerResultsFromGeneric(response.data, 'custom', cleanQuery, config.responsePath)
}

function getAnonymousGiphyId(): string {
  const storageKey = 'talk-giphy-anonymous-id'
  try {
    const existing = localStorage.getItem(storageKey)
    if (existing) return existing
    const created = crypto.randomUUID()
    localStorage.setItem(storageKey, created)
    return created
  } catch {
    return crypto.randomUUID()
  }
}

export async function trackRemoteStickerSend(result: RemoteStickerResult): Promise<void> {
  if (result.provider !== 'giphy' || !result.trackingUrl) return
  try {
    const url = new URL(result.trackingUrl)
    url.searchParams.set('ts', String(Date.now()))
    url.searchParams.set('customer_id', getAnonymousGiphyId())
    await mediaRequest(url.toString(), { responseKind: 'text', timeoutMs: 10_000 })
  } catch {
    // Analytics must never block a message from being sent.
  }
}

function generatedImageFromPayload(
  payload: unknown,
  provider: Exclude<ImageProviderId, 'none'>,
  query: string,
  responsePath = '',
): GeneratedImageResult | null {
  const selected = getPath(payload, responsePath)
  const direct = imageUrl(selected) ?? imageUrl(payload)
  if (direct) return { url: direct, query, provider }
  const urls: string[] = []
  collectImageUrls(selected, urls)
  if (urls.length === 0 && selected !== payload) collectImageUrls(payload, urls)
  return urls[0] ? { url: urls[0], query, provider } : null
}

function atlasPredictionId(payload: unknown): string {
  const values = [
    getPath(payload, 'data.id'),
    getPath(payload, 'data.prediction_id'),
    getPath(payload, 'id'),
    getPath(payload, 'prediction_id'),
  ]
  return values.find((value): value is string => typeof value === 'string' && !!value.trim())?.trim() ?? ''
}

async function generateAtlas(
  settings: Pick<AppSettings, 'imageProviders'>,
  query: string,
): Promise<GeneratedImageResult | null> {
  const config = settings.imageProviders.atlas
  const baseUrl = trimBaseUrl(config.baseUrl)
  const response = await mediaRequest(`${baseUrl}/model/generateImage`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey.trim()}`, 'Content-Type': 'application/json' },
    data: {
      model: config.model,
      prompt: joinedPrompt(config.promptPrefix, query),
      size: config.size,
      enable_base64_output: false,
    },
  })
  ensureOk(response, 'Atlas')
  const immediate = generatedImageFromPayload(getPath(response.data, 'data.outputs') ?? response.data, 'atlas', query)
  if (immediate) return immediate
  const predictionId = atlasPredictionId(response.data)
  if (!predictionId) throw new Error('Atlas 已接收请求，但没有返回任务 ID')

  for (let attempt = 0; attempt < 90; attempt += 1) {
    const poll = await mediaRequest(`${baseUrl}/model/prediction/${encodeURIComponent(predictionId)}`, {
      headers: { Authorization: `Bearer ${config.apiKey.trim()}` },
    })
    ensureOk(poll, 'Atlas 任务查询')
    const status = String(getPath(poll.data, 'data.status') ?? getPath(poll.data, 'status') ?? '').toLowerCase()
    const result = generatedImageFromPayload(getPath(poll.data, 'data.outputs') ?? getPath(poll.data, 'outputs'), 'atlas', query)
    if (result) return result
    if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) {
      const error = getPath(poll.data, 'data.error') ?? getPath(poll.data, 'error')
      throw new Error(`Atlas 生图失败${typeof error === 'string' ? `：${error.slice(0, 180)}` : ''}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  throw new Error('Atlas 生图等待超时，请稍后重试')
}

async function generateNovelAi(
  settings: Pick<AppSettings, 'imageProviders'>,
  query: string,
): Promise<GeneratedImageResult | null> {
  const config = settings.imageProviders.novelai
  const prompt = joinedPrompt(config.promptPrefix, query)
  const response = await mediaRequest(`${trimBaseUrl(config.baseUrl)}/ai/generate-image`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey.trim()}`, 'Content-Type': 'application/json' },
    data: {
      action: 'generate',
      input: prompt,
      model: config.model,
      parameters: {
        params_version: 3,
        prefer_brownian: true,
        negative_prompt: config.negativePrompt,
        height: config.height,
        width: config.width,
        scale: config.scale,
        seed: Math.floor(Math.random() * 9_999_999_999),
        sampler: config.sampler,
        noise_schedule: config.scheduler,
        steps: config.steps,
        n_samples: 1,
        ucPreset: 0,
        qualityToggle: false,
        add_original_image: false,
        controlnet_strength: 1,
        deliberate_euler_ancestral_bug: false,
        dynamic_thresholding: false,
        legacy: false,
        legacy_v3_extend: false,
        sm: false,
        sm_dyn: false,
        uncond_scale: 1,
        skip_cfg_above_sigma: null,
        use_coords: false,
        characterPrompts: [],
        reference_image_multiple: [],
        reference_information_extracted_multiple: [],
        reference_strength_multiple: [],
        v4_negative_prompt: {
          caption: { base_caption: config.negativePrompt, char_captions: [] },
        },
        v4_prompt: {
          caption: { base_caption: prompt, char_captions: [] },
          use_coords: false,
          use_order: true,
        },
      },
    },
    responseKind: 'bytes',
  })
  ensureOk(response, 'NovelAI')
  const archive = unzipSync(response.data as Uint8Array)
  const imageEntry = Object.entries(archive).find(([name]) => /\.(png|jpe?g|webp)$/i.test(name))
  if (!imageEntry) throw new Error('NovelAI 返回的压缩包里没有图片')
  const extension = imageEntry[0].toLowerCase().split('.').pop()
  const contentType = extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : extension === 'webp' ? 'image/webp' : 'image/png'
  return { url: bytesToDataUrl(imageEntry[1], contentType), query, provider: 'novelai' }
}

function comfyHeaders(apiKey: string): Record<string, string> {
  return apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {}
}

function buildComfyWorkflow(config: AppSettings['imageProviders']['comfyui'], query: string): Record<string, unknown> {
  return {
    '3': {
      class_type: 'KSampler',
      inputs: {
        cfg: config.cfg,
        denoise: 1,
        latent_image: ['5', 0],
        model: ['4', 0],
        negative: ['7', 0],
        positive: ['6', 0],
        sampler_name: config.sampler,
        scheduler: config.scheduler,
        seed: Math.floor(Math.random() * 4_294_967_295),
        steps: config.steps,
      },
    },
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: config.model } },
    '5': { class_type: 'EmptyLatentImage', inputs: { batch_size: 1, height: config.height, width: config.width } },
    '6': { class_type: 'CLIPTextEncode', inputs: { clip: ['4', 1], text: joinedPrompt(config.promptPrefix, query) } },
    '7': { class_type: 'CLIPTextEncode', inputs: { clip: ['4', 1], text: config.negativePrompt } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'Talk', images: ['8', 0] } },
  }
}

async function generateComfyUi(
  settings: Pick<AppSettings, 'imageProviders'>,
  query: string,
): Promise<GeneratedImageResult | null> {
  const config = settings.imageProviders.comfyui
  const baseUrl = trimBaseUrl(config.baseUrl)
  const headers = { ...comfyHeaders(config.apiKey), 'Content-Type': 'application/json' }
  const submit = await mediaRequest(`${baseUrl}/prompt`, {
    method: 'POST',
    headers,
    data: { prompt: buildComfyWorkflow(config, query), client_id: crypto.randomUUID() },
  })
  ensureOk(submit, 'ComfyUI')
  const promptId = getPath(submit.data, 'prompt_id')
  if (typeof promptId !== 'string' || !promptId) throw new Error('ComfyUI 没有返回 prompt_id')

  for (let attempt = 0; attempt < 120; attempt += 1) {
    const historyResponse = await mediaRequest(`${baseUrl}/history/${encodeURIComponent(promptId)}`, {
      headers: comfyHeaders(config.apiKey),
    })
    ensureOk(historyResponse, 'ComfyUI 历史查询')
    const history = getPath(historyResponse.data, promptId) ?? historyResponse.data
    const outputs = getPath(history, 'outputs')
    if (outputs && typeof outputs === 'object') {
      for (const output of Object.values(outputs as Record<string, unknown>)) {
        if (!output || typeof output !== 'object') continue
        const record = output as Record<string, unknown>
        const media = Array.isArray(record.images) ? record.images : Array.isArray(record.gifs) ? record.gifs : []
        const first = media[0]
        if (!first || typeof first !== 'object') continue
        const item = first as Record<string, unknown>
        if (typeof item.filename !== 'string') continue
        const params = new URLSearchParams({
          filename: item.filename,
          subfolder: typeof item.subfolder === 'string' ? item.subfolder : '',
          type: typeof item.type === 'string' ? item.type : 'output',
        })
        const imageResponse = await mediaRequest(`${baseUrl}/view?${params}`, {
          headers: comfyHeaders(config.apiKey),
          responseKind: 'bytes',
        })
        ensureOk(imageResponse, 'ComfyUI 图片读取')
        return {
          url: bytesToDataUrl(imageResponse.data as Uint8Array, imageResponse.contentType.split(';')[0] || 'image/png'),
          query,
          provider: 'comfyui',
        }
      }
    }
    const status = getPath(history, 'status.status_str')
    if (status === 'error') throw new Error('ComfyUI 工作流执行失败，请检查模型与节点配置')
    await new Promise((resolve) => setTimeout(resolve, 1_500))
  }
  throw new Error('ComfyUI 生图等待超时，请检查队列')
}

function stableDiffusionHeaders(username: string, password: string): Record<string, string> {
  return username || password ? { Authorization: `Basic ${utf8ToBase64(`${username}:${password}`)}` } : {}
}

async function generateStableDiffusion(
  settings: Pick<AppSettings, 'imageProviders'>,
  query: string,
): Promise<GeneratedImageResult | null> {
  const config = settings.imageProviders.stableDiffusion
  const response = await mediaRequest(`${trimBaseUrl(config.baseUrl)}/sdapi/v1/txt2img`, {
    method: 'POST',
    headers: {
      ...stableDiffusionHeaders(config.username, config.password),
      'Content-Type': 'application/json',
    },
    data: {
      prompt: joinedPrompt(config.promptPrefix, query),
      negative_prompt: config.negativePrompt,
      steps: config.steps,
      cfg_scale: config.cfg,
      sampler_name: config.sampler,
      width: config.width,
      height: config.height,
      ...(config.model ? {
        override_settings: { sd_model_checkpoint: config.model },
        override_settings_restore_afterwards: true,
      } : {}),
    },
  })
  ensureOk(response, 'Stable Diffusion WebUI / Forge')
  const image = getPath(response.data, 'images.0')
  if (typeof image !== 'string' || !image) throw new Error('WebUI / Forge 没有返回图片')
  return {
    url: image.startsWith('data:image/') ? image : `data:image/png;base64,${image}`,
    query,
    provider: 'stable-diffusion',
  }
}

function fillBodyTemplate(template: string, prompt: string, apiKey: string): unknown {
  const escapedPrompt = JSON.stringify(prompt).slice(1, -1)
  const escapedKey = JSON.stringify(apiKey).slice(1, -1)
  const filled = template.replaceAll('{prompt}', escapedPrompt).replaceAll('{query}', escapedPrompt).replaceAll('{apiKey}', escapedKey)
  try {
    return JSON.parse(filled)
  } catch {
    throw new Error('自定义接口的请求体不是有效 JSON')
  }
}

async function generateCustom(
  settings: Pick<AppSettings, 'imageProviders'>,
  query: string,
): Promise<GeneratedImageResult | null> {
  const config = settings.imageProviders.custom
  let endpoint = fillUrlTemplate(config.endpoint, query, config.apiKey)
  endpoint = appendQueryKey(endpoint, config.apiKey, config.authMode)
  const response = await mediaRequest(endpoint, {
    method: config.method,
    headers: {
      ...customHeaders(config.apiKey, config.authMode),
      ...(config.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    },
    data: config.method === 'POST' ? fillBodyTemplate(config.bodyTemplate, query, config.apiKey) : undefined,
    responseKind: 'auto',
  })
  ensureOk(response, '自定义图片接口')
  return generatedImageFromPayload(response.data, 'custom', query, config.responsePath)
}

export async function generateRemoteImage(
  settings: Pick<AppSettings, 'imageProvider' | 'imageProviders'>,
  query: string,
): Promise<GeneratedImageResult | null> {
  if (!isImageProviderReady(settings)) return null
  if (settings.imageProvider === 'atlas') return generateAtlas(settings, query)
  if (settings.imageProvider === 'novelai') return generateNovelAi(settings, query)
  if (settings.imageProvider === 'comfyui') return generateComfyUi(settings, query)
  if (settings.imageProvider === 'stable-diffusion') return generateStableDiffusion(settings, query)
  if (settings.imageProvider === 'custom') return generateCustom(settings, query)
  return null
}

function optionList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && !!item.trim()).map((item) => item.trim())
}

export async function loadImageProviderOptions(
  settings: Pick<AppSettings, 'imageProviders'>,
  provider: ImageProviderId,
): Promise<ImageProviderOptions> {
  if (provider === 'novelai') {
    return {
      models: [
        'nai-diffusion-4-5-full',
        'nai-diffusion-4-5-curated',
        'nai-diffusion-4-full',
        'nai-diffusion-4-curated-preview',
        'nai-diffusion-3',
      ],
      samplers: ['k_euler_ancestral', 'k_euler', 'k_dpmpp_2m', 'k_dpmpp_sde', 'k_dpmpp_2s_ancestral', 'k_dpm_fast', 'ddim'],
      schedulers: ['karras', 'native', 'exponential', 'polyexponential'],
    }
  }
  if (provider === 'comfyui') {
    const config = settings.imageProviders.comfyui
    const response = await mediaRequest(`${trimBaseUrl(config.baseUrl)}/object_info`, {
      headers: comfyHeaders(config.apiKey),
    })
    ensureOk(response, 'ComfyUI')
    return {
      models: optionList(getPath(response.data, 'CheckpointLoaderSimple.input.required.ckpt_name.0')),
      samplers: optionList(getPath(response.data, 'KSampler.input.required.sampler_name.0')),
      schedulers: optionList(getPath(response.data, 'KSampler.input.required.scheduler.0')),
    }
  }
  if (provider === 'stable-diffusion') {
    const config = settings.imageProviders.stableDiffusion
    const headers = stableDiffusionHeaders(config.username, config.password)
    const [modelsResponse, samplersResponse, schedulersResponse] = await Promise.all([
      mediaRequest(`${trimBaseUrl(config.baseUrl)}/sdapi/v1/sd-models`, { headers }),
      mediaRequest(`${trimBaseUrl(config.baseUrl)}/sdapi/v1/samplers`, { headers }),
      mediaRequest(`${trimBaseUrl(config.baseUrl)}/sdapi/v1/schedulers`, { headers }),
    ])
    ensureOk(modelsResponse, 'WebUI / Forge 模型列表')
    ensureOk(samplersResponse, 'WebUI / Forge 采样器列表')
    const names = (payload: unknown, keys: string[]) => Array.isArray(payload)
      ? payload.flatMap((item) => {
          if (!item || typeof item !== 'object') return []
          const record = item as Record<string, unknown>
          const found = keys.map((key) => record[key]).find((value) => typeof value === 'string')
          return typeof found === 'string' ? [found] : []
        })
      : []
    return {
      models: names(modelsResponse.data, ['title', 'model_name', 'name']),
      samplers: names(samplersResponse.data, ['name']),
      schedulers: schedulersResponse.status >= 200 && schedulersResponse.status < 300
        ? names(schedulersResponse.data, ['label', 'name'])
        : [],
    }
  }
  if (provider === 'atlas') {
    return {
      models: ['bytedance/seedream-v4', 'bytedance/seedream-v5.0-pro/text-to-image'],
      samplers: [],
      schedulers: [],
    }
  }
  return { models: [], samplers: [], schedulers: [] }
}

export async function testImageProviderConnection(
  settings: Pick<AppSettings, 'imageProvider' | 'imageProviders'>,
): Promise<string> {
  const provider = settings.imageProvider
  if (provider === 'none') throw new Error('请先启用一个图片服务')
  if (provider === 'novelai') {
    const response = await mediaRequest('https://api.novelai.net/user/subscription', {
      headers: { Authorization: `Bearer ${settings.imageProviders.novelai.apiKey.trim()}` },
    })
    ensureOk(response, 'NovelAI')
    return 'NovelAI Token 有效'
  }
  if (provider === 'comfyui') {
    const config = settings.imageProviders.comfyui
    const response = await mediaRequest(`${trimBaseUrl(config.baseUrl)}/system_stats`, {
      headers: comfyHeaders(config.apiKey),
    })
    ensureOk(response, 'ComfyUI')
    return 'ComfyUI 已连接'
  }
  if (provider === 'stable-diffusion') {
    const options = await loadImageProviderOptions(settings, provider)
    return `WebUI / Forge 已连接，读取到 ${options.models.length} 个模型`
  }
  const generated = await generateRemoteImage(settings, 'a cute orange cat sticker, clean background')
  if (!generated) throw new Error('接口已响应，但没有解析到图片')
  return '接口调用成功并生成了测试图片'
}

