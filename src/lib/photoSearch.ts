/**
 * Real-photo sourcing for auto-generated contact avatars and moments
 * illustrations — see lib/avatarCategory.ts for the category-picking logic
 * (code-driven, not LLM) that decides when each of these gets used.
 */
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
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=${orientation}`
  const res = await fetch(url, { headers: { Authorization: apiKey } })
  if (!res.ok) {
    console.warn(`[photo] Pexels搜索失败 query="${query}" HTTP ${res.status}`)
    throw new Error(`Pexels搜索失败 HTTP ${res.status}`)
  }
  const json = await res.json()
  const photo = json?.photos?.[0]
  if (!photo) {
    console.warn(`[photo] Pexels搜索无结果 query="${query}"`)
    return null
  }
  const src = orientation === 'square' ? (photo.src?.medium ?? photo.src?.small) : (photo.src?.large ?? photo.src?.medium)
  if (!src) {
    console.warn(`[photo] Pexels返回结果但没有可用图片链接 query="${query}"`)
    return null
  }
  console.log(`[photo] Pexels搜索成功 query="${query}" photographer=${photo.photographer ?? '未知'}`)
  return {
    url: src,
    photographer: typeof photo.photographer === 'string' ? photo.photographer : undefined,
    photographerUrl: typeof photo.photographer_url === 'string' ? photo.photographer_url : undefined,
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
