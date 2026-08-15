import type { AppSettings, Contact, ContactSpeechVoice, SpeechProviderId, SpeechProvidersSettings } from '../types'

export interface SpeechVoiceOption {
  id: string
  name: string
  gender: 'female' | 'male' | 'neutral'
  language: 'zh' | 'en' | 'mixed'
}

export const SPEECH_PROVIDER_INFO: Array<{
  id: Exclude<SpeechProviderId, 'none'>
  name: string
  description: string
  badge?: string
}> = [
  { id: 'doubao', name: '豆包语音', description: '火山引擎 Seed-TTS，支持预置与已购买音色', badge: '中文' },
  { id: 'mimo', name: '小米 MiMo', description: 'MiMo-V2.5-TTS，支持预置音色与自然语言演绎指导', badge: '推荐' },
]

export const MIMO_VOICES: readonly SpeechVoiceOption[] = [
  { id: 'mimo_default', name: 'MiMo 默认', gender: 'neutral', language: 'mixed' },
  { id: '冰糖', name: '冰糖 · 中文女声', gender: 'female', language: 'zh' },
  { id: '茉莉', name: '茉莉 · 中文女声', gender: 'female', language: 'zh' },
  { id: '苏打', name: '苏打 · 中文男声', gender: 'male', language: 'zh' },
  { id: '白桦', name: '白桦 · 中文男声', gender: 'male', language: 'zh' },
  { id: 'Mia', name: 'Mia · 英文女声', gender: 'female', language: 'en' },
  { id: 'Chloe', name: 'Chloe · 英文女声', gender: 'female', language: 'en' },
  { id: 'Milo', name: 'Milo · 英文男声', gender: 'male', language: 'en' },
  { id: 'Dean', name: 'Dean · 英文男声', gender: 'male', language: 'en' },
] as const

export const DOUBAO_VOICES: readonly SpeechVoiceOption[] = [
  { id: 'zh_female_vv_uranus_bigtts', name: 'Vivi 2.0 · 中文女声', gender: 'female', language: 'zh' },
  { id: 'zh_female_xiaohe_uranus_bigtts', name: '小何 · 中文女声', gender: 'female', language: 'zh' },
  { id: 'zh_male_dayi_saturn_bigtts', name: '大壹 · 中文男声', gender: 'male', language: 'zh' },
] as const

export function speechVoiceOptions(settings: Pick<AppSettings, 'speechProvider' | 'speechProviders'>): SpeechVoiceOption[] {
  if (settings.speechProvider === 'mimo') return [...MIMO_VOICES]
  if (settings.speechProvider !== 'doubao') return []
  const options: SpeechVoiceOption[] = [...DOUBAO_VOICES]
  const configured = settings.speechProviders.doubao.speaker.trim()
  if (configured && !options.some((option) => option.id === configured)) {
    options.unshift({ id: configured, name: `${configured} · 已配置音色`, gender: 'neutral', language: 'mixed' })
  }
  return options
}

export function contactSpeechVoice(contact: Contact | undefined, provider: SpeechProviderId): ContactSpeechVoice | undefined {
  if (!contact || provider === 'none') return undefined
  const voice = contact.speechVoices?.[provider]
  return voice?.voiceId.trim() ? voice : undefined
}

export function speechVoiceGenerationContext(settings: Pick<AppSettings, 'speechProvider' | 'speechProviders'>): { provider: Exclude<SpeechProviderId, 'none'>; options: SpeechVoiceOption[] } | undefined {
  if (Array.isArray((settings as Partial<AppSettings>).enabledModules) && !(settings as Partial<AppSettings>).enabledModules!.includes('speech')) return undefined
  if (!isSpeechProviderReady(settings) || settings.speechProvider === 'none') return undefined
  const options = speechVoiceOptions(settings)
  return options.length ? { provider: settings.speechProvider, options } : undefined
}

export function createDefaultSpeechProviders(): SpeechProvidersSettings {
  return {
    doubao: {
      baseUrl: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
      authMode: 'apiKey',
      apiKey: '',
      appId: '',
      accessKey: '',
      resourceId: 'seed-tts-2.0',
      speaker: 'zh_female_vv_uranus_bigtts',
      format: 'mp3',
      sampleRate: 24000,
      speedRatio: 1,
      loudnessRatio: 1,
      emotion: '',
      emotionScale: 4,
    },
    mimo: {
      baseUrl: 'https://api.xiaomimimo.com/v1',
      apiKey: '',
      model: 'mimo-v2.5-tts',
      voice: 'mimo_default',
      format: 'mp3',
      styleInstruction: '自然、口语化，像在和熟悉的人聊天。',
      temperature: 0.6,
    },
  }
}

function mergeNested<T extends object>(defaults: T, value: unknown): T {
  if (!value || typeof value !== 'object') return { ...defaults }
  return { ...defaults, ...(value as Partial<T>) }
}

export function normalizeSpeechProviders(value: unknown): SpeechProvidersSettings {
  const defaults = createDefaultSpeechProviders()
  const record = value && typeof value === 'object' ? value as Partial<SpeechProvidersSettings> : {}
  const doubao = mergeNested(defaults.doubao, record.doubao)
  const mimo = mergeNested(defaults.mimo, record.mimo)
  doubao.speedRatio = Math.max(0.1, Math.min(2, Number(doubao.speedRatio) || 1))
  doubao.loudnessRatio = Math.max(0.5, Math.min(2, Number(doubao.loudnessRatio) || 1))
  doubao.emotionScale = Math.max(1, Math.min(5, Number(doubao.emotionScale) || 4))
  if (![8000, 16000, 24000].includes(doubao.sampleRate)) doubao.sampleRate = 24000
  if (!['mp3', 'ogg_opus'].includes(doubao.format)) doubao.format = 'mp3'
  if (!['apiKey', 'accessKey'].includes(doubao.authMode)) doubao.authMode = 'apiKey'
  mimo.model = 'mimo-v2.5-tts'
  mimo.temperature = Math.max(0, Math.min(1.5, Number(mimo.temperature) || 0.6))
  if (!['mp3', 'wav'].includes(mimo.format)) mimo.format = 'mp3'
  return { doubao, mimo }
}

export function isSpeechProviderReady(settings: Pick<AppSettings, 'speechProvider' | 'speechProviders'>): boolean {
  const { speechProvider: provider, speechProviders: providers } = settings
  if (provider === 'none') return false
  if (provider === 'mimo') {
    const config = providers.mimo
    return !!config.apiKey.trim() && !!config.baseUrl.trim() && !!config.voice.trim()
  }
  const config = providers.doubao
  const authenticated = config.authMode === 'apiKey'
    ? !!config.apiKey.trim()
    : !!config.appId.trim() && !!config.accessKey.trim()
  return authenticated && !!config.baseUrl.trim() && !!config.resourceId.trim() && !!config.speaker.trim()
}

export function speechProviderName(provider: SpeechProviderId): string {
  if (provider === 'none') return '未启用'
  return SPEECH_PROVIDER_INFO.find((item) => item.id === provider)?.name ?? provider
}
