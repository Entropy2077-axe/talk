/**
 * Real-photo sourcing for auto-generated contact avatars and moments
 * illustrations — see lib/avatarCategory.ts for the category-picking logic
 * (code-driven, not LLM) that decides when each of these gets used.
 */
import { friendlyConnectionError, httpFailureMessage, parseJsonText, requireApiKey } from './connectionError'

export interface PhotoResult {
  url: string
  photographer?: string
  photographerUrl?: string
}

/** landscape/pet/person categories all go through Pexels, just with different search keywords and orientations. */
export async function searchPexelsPhoto(
  apiKey: string,
  query: string,
  orientation: 'square' | 'landscape' = 'square',
): Promise<PhotoResult | null> {
  try {
    const key = requireApiKey(apiKey, 'Pexels')
    const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=${orientation}`
    const res = await fetch(url, { headers: { Authorization: key } })
    const body = await res.text()
    let json: { photos?: unknown } & Record<string, unknown>
    try {
      json = parseJsonText(body, 'Pexels') as typeof json
    } catch (error) {
      if (res.ok || /^\s*</.test(body)) throw error
      json = { message: body.slice(0, 180) }
    }
    if (!res.ok) {
      // Don't log the full key (even to the user's own console), but its
      // length + last 4 chars is enough to tell truncated keys apart.
      const keyHint = `len=${key.length} 末4位=${key.slice(-4)}`
      console.warn(
        `[photo] Pexels搜索失败 query="${query}" HTTP ${res.status} key:${keyHint} body:${body.slice(0, 200)}`,
      )
      throw new Error(httpFailureMessage('Pexels', res.status, json))
    }
    if (!Array.isArray(json?.photos)) throw new Error('Pexels 返回的数据格式不正确，请确认使用的是 Pexels API Key')
    const photo = json.photos[0]
    if (!photo) {
      console.warn(`[photo] Pexels搜索无结果 query="${query}"`)
      return null
    }
    const record = photo && typeof photo === 'object' ? photo as Record<string, unknown> : {}
    const sources = record.src && typeof record.src === 'object' ? record.src as Record<string, unknown> : {}
    const src = orientation === 'square' ? (sources.medium ?? sources.small) : (sources.large ?? sources.medium)
    if (typeof src !== 'string' || !src) {
      console.warn(`[photo] Pexels返回结果但没有可用图片链接 query="${query}"`)
      return null
    }
    console.log(`[photo] Pexels搜索成功 query="${query}" photographer=${record.photographer ?? '未知'}`)
    return {
      url: String(src),
      photographer: typeof record.photographer === 'string' ? record.photographer : undefined,
      photographerUrl: typeof record.photographer_url === 'string' ? record.photographer_url : undefined,
    }
  } catch (error) {
    throw new Error(friendlyConnectionError(error, 'Pexels'))
  }
}

/** waifu.pics has no search — just returns one random image per category, no key needed. Anime avatars pick randomly between a couple of generic (not single-character) categories for variety. */
const ANIME_CATEGORIES = ['waifu', 'neko']

export async function randomAnimeAvatar(): Promise<PhotoResult | null> {
  const category = ANIME_CATEGORIES[Math.floor(Math.random() * ANIME_CATEGORIES.length)]
  const res = await fetch(`https://api.waifu.pics/sfw/${category}`)
  if (!res.ok) {
    console.warn(`[photo] waifu.pics请求失败 category=${category} HTTP ${res.status}`)
    throw new Error(`waifu.pics请求失败 HTTP ${res.status}`)
  }
  const json = await res.json()
  if (typeof json?.url !== 'string') {
    console.warn(`[photo] waifu.pics返回结果没有图片链接 category=${category}`)
    return null
  }
  console.log(`[photo] waifu.pics获取成功 category=${category}`)
  return { url: json.url }
}
