import { afterEach, describe, expect, it, vi } from 'vitest'
import { chatCompletion, chatCompletionProgress } from './deepseek'
import { useSettingsStore } from '../store/useSettingsStore'
import { legacyFieldsForApiConfig } from './aiApiConfigs'
import type { AiApiConfig } from '../types'

const original = useSettingsStore.getState()
afterEach(() => { useSettingsStore.setState(original, true); vi.unstubAllGlobals() })
const configs: AiApiConfig[] = ['first', 'second'].map((id) => ({ id, name: id, provider: 'custom', apiKey: `test-${id}`, baseUrl: `https://${id}.example/v1`, model: `chat-${id}`, utilityModel: `utility-${id}`, sampling: {}, createdAt: 1, updatedAt: 1 }))
function setup() {
  useSettingsStore.getState().setSettings({ aiApiConfigs: configs, activeAiApiConfigId: 'second', ...legacyFieldsForApiConfig(configs[1]) })
  return { ...legacyFieldsForApiConfig(configs[1]), messages: [{ role: 'user' as const, content: 'hello' }], singleRequest: true }
}
describe('manual API selection', () => {
  for (const streaming of [false, true]) for (const status of [429, 500]) {
    it(`${streaming ? 'streaming' : 'normal'} ${status} never switches to another saved API`, async () => {
      const opts = setup()
      const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: { message: 'temporarily unavailable' } }), { status }))
      vi.stubGlobal('fetch', fetchMock)
      await expect(streaming ? chatCompletionProgress({ ...opts, onProgress: () => {} }) : chatCompletion(opts)).rejects.toThrow()
      expect(fetchMock).toHaveBeenCalled()
      expect(fetchMock.mock.calls.every(([url]) => String(url).startsWith('https://second.example/'))).toBe(true)
    })
  }
  it('uses the selected utility model and permits a subsequent manual switch', async () => {
    setup()
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    for (const config of [configs[1], configs[0]]) {
      useSettingsStore.getState().setSettings({ activeAiApiConfigId: config.id })
      const s = useSettingsStore.getState()
      await chatCompletion({ apiKey: s.apiKey, baseUrl: s.baseUrl, model: s.utilityModel, messages: [{ role: 'user', content: 'hello' }] })
      const call = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit]
      expect(call[0]).toContain(`${config.id}.example`)
      expect(JSON.parse(String(call[1].body)).model).toBe(`utility-${config.id}`)
    }
  })
  it('restores the old preferred API without keeping fallback order', () => {
    useSettingsStore.getState().setSettings({ activeAiApiConfigId: undefined, aiApiConfigs: configs, ...{ aiApiFailoverOrder: ['second', 'first'] } })
    const result = useSettingsStore.getState()
    expect(result.activeAiApiConfigId).toBe('second')
    expect(result.apiKey).toBe('test-second')
    expect(result).not.toHaveProperty('aiApiFailoverOrder')
  })
})
