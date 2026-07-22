/**
 * Tavily is purpose-built for LLM/agent search grounding — it returns
 * already-summarized snippets instead of raw HTML, which is exactly what a
 * background "gather knowledge for a prompt" job wants, no scraping needed.
 * Only used by the knowledge-base refresh job (lib/knowledgeBase.ts), never
 * live during normal chat — see the design discussion in CLAUDE.md.
 */
export interface WebSearchResult {
  title: string
  content: string
  url: string
}

import { friendlyConnectionError, httpFailureMessage, parseJsonText, requireApiKey } from './connectionError'

export async function tavilySearch(apiKey: string, query: string): Promise<WebSearchResult[]> {
  try {
    const key = requireApiKey(apiKey, 'Tavily')
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: key,
        query,
        search_depth: 'basic',
        max_results: 5,
      }),
    })
    const text = await res.text()
    const json = parseJsonText(text, 'Tavily') as { results?: unknown }
    if (!res.ok) throw new Error(httpFailureMessage('Tavily', res.status, json))
    if (!Array.isArray(json?.results)) throw new Error('Tavily 返回的数据中没有搜索结果，请检查 API Key 或稍后重试')
    return json.results.map((r: { title?: unknown; content?: unknown; url?: unknown }) => ({
      title: typeof r?.title === 'string' ? r.title : '',
      content: typeof r?.content === 'string' ? r.content : '',
      url: typeof r?.url === 'string' ? r.url : '',
    }))
  } catch (error) {
    throw new Error(friendlyConnectionError(error, 'Tavily'))
  }
}
