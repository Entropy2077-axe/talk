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

export async function tavilySearch(apiKey: string, query: string): Promise<WebSearchResult[]> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: 'basic',
      max_results: 5,
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Tavily搜索失败 HTTP ${res.status}: ${text.slice(0, 300)}`)
  }
  const json = await res.json()
  const results = Array.isArray(json?.results) ? json.results : []
  return results.map((r: { title?: unknown; content?: unknown; url?: unknown }) => ({
    title: typeof r.title === 'string' ? r.title : '',
    content: typeof r.content === 'string' ? r.content : '',
    url: typeof r.url === 'string' ? r.url : '',
  }))
}
