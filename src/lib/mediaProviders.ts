import type {
  AppSettings,
  ImageProviderId,
  ImageProvidersSettings,
  StickerProviderId,
  StickerProvidersSettings,
} from '../types'

export const STICKER_PROVIDER_INFO: Array<{
  id: Exclude<StickerProviderId, 'none'>
  name: string
  description: string
  badge?: string
}> = [
  { id: 'giphy', name: 'GIPHY', description: '覆盖面广，直接输入 API Key 即可使用', badge: '推荐' },
  { id: 'klipy', name: 'KLIPY', description: 'GIF、贴纸和梗图搜索，接口兼容 Tenor' },
  { id: 'tenor', name: 'Tenor', description: '适合已有 Tenor API Key 的用户', badge: '旧 Key' },
  { id: 'custom', name: '其他接口', description: '兼容返回图片 URL 的自定义 GET 接口' },
]

export const IMAGE_PROVIDER_INFO: Array<{
  id: Exclude<ImageProviderId, 'none'>
  name: string
  description: string
  badge?: string
}> = [
  { id: 'atlas', name: 'Atlas Cloud', description: '云端生图，只需 API Key 并选择模型参数', badge: '云端' },
  { id: 'novelai', name: 'NovelAI', description: 'NovelAI Image 官方接口，适合二次元图片', badge: 'NAI' },
  { id: 'comfyui', name: 'ComfyUI', description: '连接电脑上的 ComfyUI，自动构建基础工作流', badge: '本地' },
  { id: 'stable-diffusion', name: 'Stable Diffusion WebUI / Forge', description: '连接 A1111 或 Forge 的 txt2img 接口', badge: '本地' },
  { id: 'custom', name: '其他接口', description: '自定义 GET/POST、鉴权、请求体与返回路径' },
]

export function createDefaultStickerProviders(): StickerProvidersSettings {
  return {
    giphy: { apiKey: '', rating: 'pg', language: 'zh-CN' },
    klipy: { apiKey: '', contentFilter: 'medium', locale: 'zh_CN' },
    tenor: { apiKey: '', contentFilter: 'medium', locale: 'zh_CN' },
    custom: { endpoint: '', apiKey: '', authMode: 'none', responsePath: '' },
  }
}

export function createDefaultImageProviders(): ImageProvidersSettings {
  return {
    atlas: {
      apiKey: '',
      baseUrl: 'https://api.atlascloud.ai/api/v1',
      model: 'bytedance/seedream-v4',
      size: '1024*1024',
      promptPrefix: '',
    },
    novelai: {
      apiKey: '',
      baseUrl: 'https://image.novelai.net',
      model: 'nai-diffusion-4-5-full',
      width: 1024,
      height: 1024,
      steps: 28,
      scale: 5,
      sampler: 'k_euler_ancestral',
      scheduler: 'karras',
      negativePrompt: 'lowres, bad anatomy, blurry, text, watermark',
      promptPrefix: '',
    },
    comfyui: {
      baseUrl: 'http://127.0.0.1:8188',
      apiKey: '',
      model: '',
      width: 768,
      height: 768,
      steps: 24,
      cfg: 7,
      sampler: 'euler',
      scheduler: 'normal',
      negativePrompt: 'low quality, blurry, text, watermark',
      promptPrefix: '',
    },
    stableDiffusion: {
      baseUrl: 'http://127.0.0.1:7860',
      username: '',
      password: '',
      model: '',
      width: 768,
      height: 768,
      steps: 24,
      cfg: 7,
      sampler: 'Euler a',
      negativePrompt: 'low quality, blurry, text, watermark',
      promptPrefix: '',
    },
    custom: {
      endpoint: '',
      apiKey: '',
      method: 'POST',
      authMode: 'bearer',
      bodyTemplate: '{\n  "prompt": "{prompt}"\n}',
      responsePath: 'url',
    },
  }
}

function mergeNested<T extends Record<string, unknown>>(defaults: T, value: unknown): T {
  if (!value || typeof value !== 'object') return { ...defaults }
  return { ...defaults, ...(value as Partial<T>) }
}

export function normalizeStickerProviders(value: unknown): StickerProvidersSettings {
  const defaults = createDefaultStickerProviders()
  const record = value && typeof value === 'object' ? value as Partial<StickerProvidersSettings> : {}
  return {
    giphy: mergeNested(defaults.giphy, record.giphy),
    klipy: mergeNested(defaults.klipy, record.klipy),
    tenor: mergeNested(defaults.tenor, record.tenor),
    custom: mergeNested(defaults.custom, record.custom),
  }
}

export function normalizeImageProviders(value: unknown): ImageProvidersSettings {
  const defaults = createDefaultImageProviders()
  const record = value && typeof value === 'object' ? value as Partial<ImageProvidersSettings> : {}
  return {
    atlas: mergeNested(defaults.atlas, record.atlas),
    novelai: mergeNested(defaults.novelai, record.novelai),
    comfyui: mergeNested(defaults.comfyui, record.comfyui),
    stableDiffusion: mergeNested(defaults.stableDiffusion, record.stableDiffusion),
    custom: mergeNested(defaults.custom, record.custom),
  }
}

export function isStickerProviderReady(settings: Pick<AppSettings, 'stickerProvider' | 'stickerProviders'>): boolean {
  const { stickerProvider: provider, stickerProviders: providers } = settings
  if (provider === 'none') return false
  if (provider === 'custom') return !!providers.custom.endpoint.trim()
  return !!providers[provider].apiKey.trim()
}

export function isImageProviderReady(settings: Pick<AppSettings, 'imageProvider' | 'imageProviders'>): boolean {
  const { imageProvider: provider, imageProviders: providers } = settings
  if (provider === 'none') return false
  if (provider === 'atlas') return !!providers.atlas.apiKey.trim()
  if (provider === 'novelai') return !!providers.novelai.apiKey.trim()
  if (provider === 'comfyui') return !!providers.comfyui.baseUrl.trim() && !!providers.comfyui.model.trim()
  if (provider === 'stable-diffusion') return !!providers.stableDiffusion.baseUrl.trim()
  return !!providers.custom.endpoint.trim()
}

export function stickerProviderName(provider: StickerProviderId): string {
  if (provider === 'none') return '未启用'
  return STICKER_PROVIDER_INFO.find((item) => item.id === provider)?.name ?? provider
}

export function imageProviderName(provider: ImageProviderId): string {
  if (provider === 'none') return '未启用'
  return IMAGE_PROVIDER_INFO.find((item) => item.id === provider)?.name ?? provider
}

