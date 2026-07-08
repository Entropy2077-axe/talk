import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { DEFAULT_STYLE_PROMPT } from '../lib/prompt'
import { INITIAL_WALLET_BALANCE } from '../lib/wallet'
import type { AppSettings } from '../types'

interface SettingsState extends AppSettings {
  setSettings: (patch: Partial<AppSettings>) => void
}

const envKey = import.meta.env.VITE_DEEPSEEK_API_KEY ?? ''
const envBaseUrl = import.meta.env.VITE_DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
const envTavilyKey = import.meta.env.VITE_TAVILY_API_KEY ?? ''
const envPexelsKey = import.meta.env.VITE_PEXELS_API_KEY ?? ''

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      apiKey: envKey,
      baseUrl: envBaseUrl,
      model: 'deepseek-v4-pro',
      utilityModel: 'deepseek-v4-flash',
      globalSystemPrompt: DEFAULT_STYLE_PROMPT,
      userNickname: '我',
      userAvatar: '🙂',
      userGender: '',
      userBirthday: '',
      userBio: '',
      walletBalance: INITIAL_WALLET_BALANCE,
      momentsCoverPhoto: '',
      momentsLastReadAt: 0,
      proactiveDailyCap: 3,
      proactiveProbability: 0.25,
      proactiveSilenceThresholdMs: 45 * 60 * 1000,
      proactiveCooldownMs: 6 * 60 * 60 * 1000,
      proactiveMomentsMax: 3,
      proactiveTickIntervalMs: 5 * 60 * 1000,
      tavilyApiKey: envTavilyKey,
      worldview: '',
      pexelsApiKey: envPexelsKey,
      themeMode: 'light',
      chatBackground: '',
      currencyIconMode: 'coin',
      customCurrencyEmoji: '💎',
      moodExpiryMs: 30 * 60 * 1000,
      validatorMode: 'quality',
      selfIterationGlobalPrompt: '',
      adminModeEnabled: false,
      enabledModules: ['shop', 'warehouse', 'worldview', 'knowledgeBase', 'relationship', 'personalityTraits', 'mood', 'intent', 'validator'],
      setSettings: (patch) => set(patch),
    }),
    {
      name: 'talk-settings',
      version: 1,
      migrate: (persisted, version) => {
        const next = persisted as Partial<SettingsState>
        if (version < 1 && Array.isArray(next.enabledModules) && !next.enabledModules.includes('intent')) {
          next.enabledModules = [...next.enabledModules, 'intent']
        }
        if (typeof next.selfIterationGlobalPrompt !== 'string') {
          next.selfIterationGlobalPrompt = ''
        }
        return next
      },
    },
  ),
)
