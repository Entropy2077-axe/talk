import { describe, expect, it } from 'vitest'
import { normalizeAiApiConfigs, orderedAiApiConfigs } from './aiApiConfigs'

const legacy = { aiProvider: 'deepseek' as const, apiKey: 'key', baseUrl: 'https://api.deepseek.com', model: 'chat', utilityModel: 'utility' }

describe('saved AI API configurations', () => {
  it('migrates the legacy connection into a primary configuration', () => {
    const configs = normalizeAiApiConfigs(undefined, legacy, { temperature: 0.7, topP: 0.8 })
    expect(configs).toHaveLength(1)
    expect(configs[0]).toMatchObject({ id: 'legacy-primary-api', apiKey: 'key', sampling: { temperature: 0.7, topP: 0.8 } })
  })

  it('honors the saved fallback order and appends omitted configurations', () => {
    const configs = normalizeAiApiConfigs([{ id: 'one', name: 'one', provider: 'deepseek', apiKey: 'key', baseUrl: legacy.baseUrl, model: legacy.model, utilityModel: legacy.utilityModel }, { id: 'two', name: 'two', provider: 'deepseek', apiKey: 'second', baseUrl: legacy.baseUrl, model: legacy.model, utilityModel: legacy.utilityModel }], legacy)
    const ordered = orderedAiApiConfigs({ ...legacy, aiApiConfigs: configs, aiApiFailoverOrder: ['two'], promptPresets: [], activePromptPresetId: '' })
    expect(ordered.map((item) => item.id)).toEqual(['two', 'one'])
  })
})
