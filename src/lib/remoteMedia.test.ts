import { afterEach, describe, expect, it, vi } from 'vitest'
import { zipSync } from 'fflate'
import { createDefaultImageProviders, createDefaultStickerProviders } from './mediaProviders'
import { generateRemoteImage, searchRemoteStickers } from './remoteMedia'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('remote sticker providers', () => {
  it('calls the fixed GIPHY sticker search endpoint and extracts the messaging rendition', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      expect(url.origin + url.pathname).toBe('https://api.giphy.com/v1/stickers/search')
      expect(url.searchParams.get('api_key')).toBe('test-key')
      expect(url.searchParams.get('q')).toBe('开心猫咪')
      return jsonResponse({
        data: [{
          title: 'happy cat',
          images: { fixed_height_small: { url: 'https://media.example/cat.gif' } },
          analytics: { onsent: { url: 'https://analytics.example/sent' } },
        }],
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const providers = createDefaultStickerProviders()
    providers.giphy.apiKey = 'test-key'

    const results = await searchRemoteStickers({ stickerProvider: 'giphy', stickerProviders: providers }, '开心猫咪')

    expect(results).toEqual([{
      url: 'https://media.example/cat.gif',
      name: 'happy cat',
      provider: 'giphy',
      trackingUrl: 'https://analytics.example/sent',
    }])
  })

  it('supports a custom nested response path without copying unrelated URLs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      docs: 'https://example.com/not-an-image-page',
      data: { results: [{ image: 'https://cdn.example/one.webp' }] },
    })))
    const providers = createDefaultStickerProviders()
    providers.custom.endpoint = 'https://stickers.example/search?q={query}'
    providers.custom.responsePath = 'data.results'

    const results = await searchRemoteStickers({ stickerProvider: 'custom', stickerProviders: providers }, 'wave')

    expect(results.map((result) => result.url)).toEqual(['https://cdn.example/one.webp'])
    expect(results[0].provider).toBe('custom')
  })
})

describe('image generation providers', () => {
  it('submits an Atlas task and polls the official prediction endpoint', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith('/model/generateImage')) {
        const body = JSON.parse(String(init?.body))
        expect(body.model).toBe('bytedance/seedream-v4')
        expect(body.prompt).toContain('orange cat')
        return jsonResponse({ data: { id: 'prediction-1' } })
      }
      return jsonResponse({ data: { status: 'completed', outputs: ['https://cdn.example/generated.png'] } })
    }))
    const providers = createDefaultImageProviders()
    providers.atlas.apiKey = 'atlas-test-key'

    const result = await generateRemoteImage({ imageProvider: 'atlas', imageProviders: providers }, 'orange cat')

    expect(calls).toEqual([
      'https://api.atlascloud.ai/api/v1/model/generateImage',
      'https://api.atlascloud.ai/api/v1/model/prediction/prediction-1',
    ])
    expect(result).toEqual({ url: 'https://cdn.example/generated.png', query: 'orange cat', provider: 'atlas' })
  })

  it('decodes the first PNG from NovelAI zip output', async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    const archive = zipSync({ 'image.png': png })
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      expect(body.action).toBe('generate')
      expect(body.parameters.v4_prompt.caption.base_caption).toContain('anime portrait')
      return new Response(archive, { status: 200, headers: { 'Content-Type': 'application/zip' } })
    }))
    const providers = createDefaultImageProviders()
    providers.novelai.apiKey = 'nai-test-token'

    const result = await generateRemoteImage({ imageProvider: 'novelai', imageProviders: providers }, 'anime portrait')

    expect(result?.provider).toBe('novelai')
    expect(result?.url).toMatch(/^data:image\/png;base64,/)
  })

  it('builds a basic ComfyUI workflow, polls history, and fetches the output image', async () => {
    const routes: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      routes.push(url)
      if (url.endsWith('/prompt')) {
        const body = JSON.parse(String(init?.body))
        expect(body.prompt['4'].inputs.ckpt_name).toBe('model.safetensors')
        expect(body.prompt['6'].inputs.text).toContain('cinematic cat')
        return jsonResponse({ prompt_id: 'comfy-1' })
      }
      if (url.endsWith('/history/comfy-1')) {
        return jsonResponse({
          'comfy-1': {
            outputs: {
              '9': { images: [{ filename: 'Talk_00001_.png', subfolder: '', type: 'output' }] },
            },
          },
        })
      }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'image/png' } })
    }))
    const providers = createDefaultImageProviders()
    providers.comfyui.model = 'model.safetensors'

    const result = await generateRemoteImage({ imageProvider: 'comfyui', imageProviders: providers }, 'cinematic cat')

    expect(routes[0]).toBe('http://127.0.0.1:8188/prompt')
    expect(routes[1]).toBe('http://127.0.0.1:8188/history/comfy-1')
    expect(routes[2]).toContain('http://127.0.0.1:8188/view?')
    expect(result?.provider).toBe('comfyui')
    expect(result?.url).toMatch(/^data:image\/png;base64,/)
  })

  it('calls the A1111 / Forge txt2img endpoint and wraps its base64 image', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('http://127.0.0.1:7860/sdapi/v1/txt2img')
      const body = JSON.parse(String(init?.body))
      expect(body.prompt).toContain('watercolor fox')
      expect(body.cfg_scale).toBe(7)
      return jsonResponse({ images: ['AQID'] })
    }))
    const providers = createDefaultImageProviders()

    const result = await generateRemoteImage({ imageProvider: 'stable-diffusion', imageProviders: providers }, 'watercolor fox')

    expect(result).toEqual({
      url: 'data:image/png;base64,AQID',
      query: 'watercolor fox',
      provider: 'stable-diffusion',
    })
  })
})

