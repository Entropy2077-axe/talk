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
import { createDefaultSpeechProviders, normalizeSpeechProviders } from '../lib/speechProviders'
import type { AppSettings } from '../types'
import { createDefaultPromptModules, normalizePromptModules } from '../lib/promptModules'
import { SYSTEM_DEFAULT_PROMPT_PRESET_ID, normalizePromptPresets } from '../lib/promptPresets'
import { normalizeChatPageSize } from '../lib/chatPagination'
import type { AiProviderId } from '../lib/aiProviders'
import { normalizeUiTheme } from '../lib/uiTheme'
import { legacyAiApiConfig, legacyFieldsForApiConfig, normalizeAiApiConfigs } from '../lib/aiApiConfigs'

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
      experienceMode: 'free',
      aiProvider: 'deepseek',
      apiKey: envKey,
      baseUrl: envBaseUrl,
      model: 'deepseek-v4-pro',
      utilityModel: 'deepseek-v4-flash',
      aiApiConfigs: [legacyAiApiConfig({ aiProvider: 'deepseek', apiKey: envKey, baseUrl: envBaseUrl, model: 'deepseek-v4-pro', utilityModel: 'deepseek-v4-flash' })],
      aiApiFailoverOrder: ['legacy-primary-api'],
      globalSystemPrompt: DEFAULT_STYLE_PROMPT,
      promptModules: createDefaultPromptModules(),
      promptPresets: normalizePromptPresets(undefined, createDefaultPromptModules()),
      activePromptPresetId: SYSTEM_DEFAULT_PROMPT_PRESET_ID,
      userNickname: '我',
      userAvatar: '🙂',
      userGender: '',
      userBirthday: '',
      userBio: '',
      userVisualIdentity: '',
      userVisualSeed: undefined,
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
      defaultWorldviewId: undefined,
      activeWorldId: undefined,
      worldSnapshotMigrationVersion: 0,
      worldEconomyIsolated: false,
      autoCompressLibraryImports: true,
      libraryCompressionThresholdTokens: 2000,
      pexelsApiKey: envPexelsKey,
      animeNsfwEnabled: false,
      avatarImageSource: 'anime',
      momentsImageSource: 'generated',
      hiddenAlbumUrls: [],
      albumSavedImages: [],
      stickerProvider: envGiphyKey ? 'giphy' : 'none',
      stickerProviders: initialStickerProviders(),
      imageProvider: envAtlasKey ? 'atlas' : 'none',
      imageProviders: initialImageProviders(),
      speechProvider: 'none',
      speechProviders: createDefaultSpeechProviders(),
      stickerApiUrl: '',
      stickerApiKey: '',
      imageApiUrl: '',
      imageApiKey: '',
      imageApiResponsePath: 'url',
      uiTheme: 'sage',
      themeMode: 'light',
      topInsetAdjustmentPx: 0,
      chatBackground: '',
      chatPageSize: 40,
      currencyIconMode: 'coin',
      animationsEnabled: true,
      customCurrencyEmoji: '💎',
      moodExpiryMs: 30 * 60 * 1000,
      chatResponseTimeoutMs: 60 * 1000,
      adminModeEnabled: false,
      enabledModules: ['shop', 'warehouse', 'saveLoad', 'relationship', 'speech', 'career', 'location'],
      setSettings: (patch) => set(patch),
    }),
    {
      name: 'talk-settings',
      version: 30,
      migrate: (persisted, version) => {
        const next = persisted as Partial<SettingsState>
        if (next.experienceMode !== 'immersive' && next.experienceMode !== 'free') next.experienceMode = 'free'
        if (!['deepseek', 'openai', 'gemini', 'anthropic', 'xai', 'qwen', 'glm', 'minimax', 'kimi', 'custom'].includes(String(next.aiProvider))) {
          next.aiProvider = 'deepseek' as AiProviderId
        }
        if (version < 1 && Array.isArray(next.enabledModules) && !next.enabledModules.includes('intent')) {
          next.enabledModules = [...next.enabledModules, 'intent']
        }
        if (version < 2 && Array.isArray(next.enabledModules)) {
          next.enabledModules = next.enabledModules.filter((id) => id !== 'validator')
        }
        if (version < 4 && Array.isArray(next.enabledModules) && !next.enabledModules.includes('career')) next.enabledModules = [...next.enabledModules, 'career']
        if (typeof next.userOccupation !== 'string') next.userOccupation = ''
        if (typeof next.userMonthlySalary !== 'number') next.userMonthlySalary = 0
        if (typeof next.jobBabyMode !== 'boolean') next.jobBabyMode = false
        if (typeof next.topInsetAdjustmentPx !== 'number') next.topInsetAdjustmentPx = 0
        if (typeof next.worldbookMigrationCompleted !== 'boolean') next.worldbookMigrationCompleted = false
        if (typeof next.autoCompressLibraryImports !== 'boolean') next.autoCompressLibraryImports = true
        if (typeof next.libraryCompressionThresholdTokens !== 'number') next.libraryCompressionThresholdTokens = 2000
        if (typeof next.worldSnapshotMigrationVersion !== 'number') next.worldSnapshotMigrationVersion = 0
        if (typeof next.worldEconomyIsolated !== 'boolean') next.worldEconomyIsolated = false
        if (!next.activeWorldId && next.defaultWorldviewId) next.activeWorldId = next.defaultWorldviewId
        if (Array.isArray(next.enabledModules)) {
          const hadWorldFeature = next.enabledModules.includes('worldview') || next.enabledModules.includes('saveLoad')
          next.enabledModules = next.enabledModules.filter((id) => id !== 'worldview')
          if (hadWorldFeature && !next.enabledModules.includes('saveLoad')) next.enabledModules.push('saveLoad')
        }
        if (typeof next.automaticAiDailyCap !== 'number') next.automaticAiDailyCap = 0
        if (typeof next.userVisualIdentity !== 'string') next.userVisualIdentity = ''
        if (typeof next.userVisualSeed !== 'number') next.userVisualSeed = undefined
        if (typeof next.animeNsfwEnabled !== 'boolean') next.animeNsfwEnabled = false
        if (!['pexels', 'anime', 'generated'].includes(String(next.avatarImageSource))) next.avatarImageSource = 'anime'
        if (!['pexels', 'anime', 'generated'].includes(String(next.momentsImageSource))) next.momentsImageSource = 'generated'
        if (typeof next.animationsEnabled !== 'boolean') next.animationsEnabled = true
        if (typeof next.chatResponseTimeoutMs !== 'number' || !Number.isFinite(next.chatResponseTimeoutMs)) next.chatResponseTimeoutMs = 60 * 1000
        else next.chatResponseTimeoutMs = Math.max(0, Math.min(10 * 60 * 1000, Math.round(next.chatResponseTimeoutMs)))
        next.chatPageSize = normalizeChatPageSize(next.chatPageSize)
        if (typeof next.stickerApiUrl !== 'string') next.stickerApiUrl = ''
        if (typeof next.stickerApiKey !== 'string') next.stickerApiKey = ''
        if (typeof next.imageApiUrl !== 'string') next.imageApiUrl = ''
        if (typeof next.imageApiKey !== 'string') next.imageApiKey = ''
        if (typeof next.imageApiResponsePath !== 'string') next.imageApiResponsePath = 'url'
        next.stickerProviders = normalizeStickerProviders(next.stickerProviders)
        next.imageProviders = normalizeImageProviders(next.imageProviders)
        next.speechProviders = normalizeSpeechProviders(next.speechProviders)
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
        if (!['none', 'doubao', 'mimo'].includes(String(next.speechProvider))) next.speechProvider = 'none'
        if (Array.isArray(next.enabledModules)) next.enabledModules = next.enabledModules.filter((id) => id !== 'mood')
        if (Array.isArray(next.enabledModules)) next.enabledModules = next.enabledModules.filter((id) => !['selfIteration', 'aiReplyAssist', 'promptModuleEditor'].includes(id))
        if (Array.isArray(next.enabledModules)) next.enabledModules = next.enabledModules.filter((id) => id !== 'slg')
        if (Array.isArray(next.enabledModules)) next.enabledModules = next.enabledModules.filter((id) => !['personalityTraits', 'intent', 'lifeSimulation'].includes(id))
        if (version < 16 && Array.isArray(next.enabledModules) && !next.enabledModules.includes('location')) next.enabledModules = [...next.enabledModules, 'location']
        if (version < 29 && Array.isArray(next.enabledModules)) {
          next.enabledModules = next.enabledModules.filter((id) => id !== 'knowledgeBase' && id !== 'storyOutline')
          if (!next.enabledModules.includes('speech')) next.enabledModules.push('speech')
        }
        if (version < 30) {
          const legacySampling = (next.promptPresets?.find((preset) => preset.id === next.activePromptPresetId) as { sampling?: unknown } | undefined)?.sampling
          next.aiApiConfigs = normalizeAiApiConfigs(next.aiApiConfigs, {
            aiProvider: next.aiProvider ?? 'deepseek', apiKey: next.apiKey ?? '', baseUrl: next.baseUrl ?? '', model: next.model ?? '', utilityModel: next.utilityModel ?? '',
          }, legacySampling)
          next.aiApiFailoverOrder = next.aiApiConfigs.map((config) => config.id)
        }
        next.uiTheme = normalizeUiTheme(next.uiTheme)
        next.promptModules = normalizePromptModules(next.promptModules, next.globalSystemPrompt)
        const normalizedPresets = normalizePromptPresets(next.promptPresets, next.promptModules)
        next.promptPresets = normalizedPresets
        if (!normalizedPresets.some((preset) => preset.id === next.activePromptPresetId)) {
          next.activePromptPresetId = normalizedPresets.find((preset) => !preset.systemDefault)?.id ?? SYSTEM_DEFAULT_PROMPT_PRESET_ID
        }
        next.aiApiConfigs = normalizeAiApiConfigs(next.aiApiConfigs, {
          aiProvider: next.aiProvider ?? 'deepseek', apiKey: next.apiKey ?? '', baseUrl: next.baseUrl ?? '', model: next.model ?? '', utilityModel: next.utilityModel ?? '',
        })
        const orderedIds = Array.isArray(next.aiApiFailoverOrder) ? next.aiApiFailoverOrder.filter((id): id is string => typeof id === 'string' && next.aiApiConfigs!.some((config) => config.id === id)) : []
        next.aiApiFailoverOrder = [...orderedIds, ...next.aiApiConfigs.map((config) => config.id).filter((id) => !orderedIds.includes(id))]
        Object.assign(next, legacyFieldsForApiConfig(next.aiApiConfigs[0]))
        return next
      },
    },
  ),
)
