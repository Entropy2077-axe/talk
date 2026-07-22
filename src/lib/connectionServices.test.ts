import { afterEach, describe, expect, it, vi } from 'vitest'
import { testConnection } from './deepseek'
import { searchPexelsPhoto } from './photoSearch'
import { tavilySearch } from './webSearch'
import { friendlyConnectionError } from './connectionError'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('connection checks', () => {
  it('translates localized browser implementation errors into actionable text', () => {
    expect(friendlyConnectionError(
      new TypeError('在 “Window” 上执行 “fetch” 失败：无法从 “RequestInit” 读取 “headers” 属性：字符串包含非 ISO-8859-1 编码点。'),
      'Pexels',
    )).toContain('API Key 含有空格、中文或特殊字符')
    expect(friendlyConnectionError(
      new SyntaxError('意外的标记 “<”，“<!doctype ...” 不是有效的 JSON'),
      'AI 接口',
    )).toContain('返回了网页而不是接口数据')
  })

  it('rejects a relative AI Base URL before sending a request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await testConnection('sk-test', '123456', 'test-model')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('http:// 或 https://')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not report success when an AI endpoint returns the app HTML', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html><html></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    })))

    const result = await testConnection('sk-test', 'https://api.example.com', 'test-model')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('返回了网页')
  })

  it('only reports AI success for a compatible chat response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '你好' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    const result = await testConnection('sk-test', 'https://api.example.com', 'test-model')

    expect(result).toEqual({ ok: true, message: '连接成功，模型已正常返回回复' })
  })

  it('explains a copied Pexels label instead of exposing the Headers error', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(searchPexelsPhoto('Pexels Key：abc', 'cat')).rejects.toThrow('含有空格、中文或特殊字符')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a Tavily success response with the wrong shape', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))

    await expect(tavilySearch('tvly-test', 'test')).rejects.toThrow('没有搜索结果')
  })
})
