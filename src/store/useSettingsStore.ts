import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { DEFAULT_STYLE_PROMPT } from '../lib/prompt'
import { INITIAL_WALLET_BALANCE } from '../lib/wallet'
import {
  createDefaultImageProviders,
  createDefaultStickerProviders,
  normalizeImageProviders,
  normalizeStickerProviders,
} from '../lib/mediaProviders'
import type { AppSettings } from '../types'
import { createDefaultPromptModules, normalizePromptModules } from '../lib/promptModules'
import { normalizeChatPageSize } from '../lib/chatPagination'

interface SettingsState extends AppSettings {
  setSettings: (patch: Partial<AppSettings>) => void
}

const envKey = import.meta.env.VITE_DEEPSEEK_API_KEY ?? ''
const envBaseUrl = import.meta.env.VITE_DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
const envTavilyKey = import.meta.env.VITE_TAVILY_API_KEY ?? ''
const envPexelsKey = import.meta.env.VITE_PEXELS_API_KEY ?? ''
const envGiphyKey = import.meta.env.VITE_GIPHY_API_KEY ?? ''
const envAtlasKey = import.meta.env.VITE_ATLAS_API_KEY ?? ''

function initialStickerProviders() {
  const providers = createDefaultStickerProviders()
  providers.giphy.apiKey = envGiphyKey
  return providers
}

function initialImageProviders() {
  const providers = createDefaultImageProviders()
  providers.atlas.apiKey = envAtlasKey
  return providers
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      apiKey: envKey,
      baseUrl: envBaseUrl,
      model: 'deepseek-v4-pro',
      utilityModel: 'deepseek-v4-flash',
      globalSystemPrompt: DEFAULT_STYLE_PROMPT,
      promptModules: createDefaultPromptModules(),
      userNickname: '我',
      userAvatar: '🙂',
      userGender: '',
      userBirthday: '',
      userBio: '',
      walletBalance: INITIAL_WALLET_BALANCE,
      userOccupation: '',
      userMonthlySalary: 0,
      jobBabyMode: false,
      momentsCoverPhoto: '',
      momentsLastReadAt: 0,
      proactiveDailyCap: 3,
      proactiveProbability: 0.25,
      proactiveSilenceThresholdMs: 45 * 60 * 1000,
      proactiveCooldownMs: 6 * 60 * 60 * 1000,
      proactiveMomentsMax: 3,
      proactiveTickIntervalMs: 5 * 60 * 1000,
      automaticAiDailyCap: 0,
      tavilyApiKey: envTavilyKey,
      worldview: '',
      worldbookMigrationCompleted: false,
      pexelsApiKey: envPexelsKey,
      stickerProvider: envGiphyKey ? 'giphy' : 'none',
      stickerProviders: initialStickerProviders(),
      imageProvider: envAtlasKey ? 'atlas' : 'none',
      imageProviders: initialImageProviders(),
      stickerApiUrl: '',
      stickerApiKey: '',
      imageApiUrl: '',
      imageApiKey: '',
      imageApiResponsePath: 'url',
      themeMode: 'light',
      topInsetAdjustmentPx: 0,
      chatBackground: '',
      chatPageSize: 40,
      currencyIconMode: 'coin',
      animationsEnabled: true,
      customCurrencyEmoji: '💎',
      moodExpiryMs: 30 * 60 * 1000,
      selfIterationGlobalPrompt: '',
      adminModeEnabled: false,
      enabledModules: ['shop', 'warehouse', 'worldview', 'knowledgeBase', 'relationship', 'personalityTraits', 'intent', 'storyOutline', 'career'],
      setSettings: (patch) => set(patch),
    }),
    {
      name: 'talk-settings',
      version: 14,
      migrate: (persisted, version) => {
        const next = persisted as Partial<SettingsState>
        if (version < 1 && Array.isArray(next.enabledModules) && !next.enabledModules.includes('intent')) {
          next.enabledModules = [...next.enabledModules, 'intent']
        }
        if (version < 2 && Array.isArray(next.enabledModules)) {
          next.enabledModules = next.enabledModules.filter((id) => id !== 'validator')
        }
        if (version < 3 && Array.isArray(next.enabledModules) && !next.enabledModules.includes('storyOutline')) {
          next.enabledModules = [...next.enabledModules, 'storyOutline']
        }
        if (version < 4 && Array.isArray(next.enabledModules) && !next.enabledModules.includes('career')) next.enabledModules = [...next.enabledModules, 'career']
        if (typeof next.userOccupation !== 'string') next.userOccupation = ''
        if (typeof next.userMonthlySalary !== 'number') next.userMonthlySalary = 0
        if (typeof next.jobBabyMode !== 'boolean') next.jobBabyMode = false
        if (typeof next.selfIterationGlobalPrompt !== 'string') {
          next.selfIterationGlobalPrompt = ''
        }
        if (typeof next.topInsetAdjustmentPx !== 'number') next.topInsetAdjustmentPx = 0
        if (typeof next.worldbookMigrationCompleted !== 'boolean') next.worldbookMigrationCompleted = false
        if (typeof next.automaticAiDailyCap !== 'number') next.automaticAiDailyCap = 0
        if (typeof next.animationsEnabled !== 'boolean') next.animationsEnabled = true
        next.chatPageSize = normalizeChatPageSize(next.chatPageSize)
        if (typeof next.stickerApiUrl !== 'string') next.stickerApiUrl = ''
        if (typeof next.stickerApiKey !== 'string') next.stickerApiKey = ''
        if (typeof next.imageApiUrl !== 'string') next.imageApiUrl = ''
        if (typeof next.imageApiKey !== 'string') next.imageApiKey = ''
        if (typeof next.imageApiResponsePath !== 'string') next.imageApiResponsePath = 'url'
        next.stickerProviders = normalizeStickerProviders(next.stickerProviders)
        next.imageProviders = normalizeImageProviders(next.imageProviders)
        if (version < 9) {
          if (next.stickerApiUrl?.trim() && !next.stickerProviders.custom.endpoint) {
            next.stickerProviders.custom.endpoint = next.stickerApiUrl.trim()
            next.stickerProviders.custom.apiKey = next.stickerApiKey?.trim() ?? ''
            next.stickerProvider = 'custom'
          }
          if (next.imageApiUrl?.trim() && !next.imageProviders.custom.endpoint) {
            next.imageProviders.custom.endpoint = next.imageApiUrl.trim()
            next.imageProviders.custom.apiKey = next.imageApiKey?.trim() ?? ''
            next.imageProviders.custom.responsePath = next.imageApiResponsePath?.trim() || 'url'
            next.imageProvider = 'custom'
          }
        }
        if (version < 10) {
          if (envGiphyKey && !next.stickerProviders.giphy.apiKey) {
            next.stickerProviders.giphy.apiKey = envGiphyKey
            if (!next.stickerProvider || next.stickerProvider === 'none') next.stickerProvider = 'giphy'
          }
          if (envAtlasKey && !next.imageProviders.atlas.apiKey) {
            next.imageProviders.atlas.apiKey = envAtlasKey
            if (!next.imageProvider || next.imageProvider === 'none') next.imageProvider = 'atlas'
          }
        }
        if (!['none', 'giphy', 'klipy', 'tenor', 'custom'].includes(String(next.stickerProvider))) next.stickerProvider = 'none'
        if (!['none', 'atlas', 'novelai', 'comfyui', 'stable-diffusion', 'custom'].includes(String(next.imageProvider))) next.imageProvider = 'none'
        if (Array.isArray(next.enabledModules)) next.enabledModules = next.enabledModules.filter((id) => id !== 'mood')
        next.promptModules = normalizePromptModules(next.promptModules, next.globalSystemPrompt)
        return next
      },
    },
  ),
)
