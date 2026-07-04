import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { DEFAULT_STYLE_PROMPT } from '../lib/prompt'
import type { AppSettings } from '../types'

interface SettingsState extends AppSettings {
  setSettings: (patch: Partial<AppSettings>) => void
}

const envKey = import.meta.env.VITE_DEEPSEEK_API_KEY ?? ''
const envBaseUrl = import.meta.env.VITE_DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      apiKey: envKey,
      baseUrl: envBaseUrl,
      model: 'deepseek-chat',
      globalSystemPrompt: DEFAULT_STYLE_PROMPT,
      userNickname: '我',
      userAvatar: '🙂',
      setSettings: (patch) => set(patch),
    }),
    { name: 'talk-settings' },
  ),
)
