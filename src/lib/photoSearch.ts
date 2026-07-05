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
    throw new Error(`Pexels搜索失败 HTTP ${res.status}`)
  }
  const json = await res.json()
  const photo = json?.photos?.[0]
  if (!photo) return null
  const src = orientation === 'square' ? (photo.src?.medium ?? photo.src?.small) : (photo.src?.large ?? photo.src?.medium)
  if (!src) return null
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
    throw new Error(`waifu.pics请求失败 HTTP ${res.status}`)
  }
  const json = await res.json()
  if (typeof json?.url !== 'string') return null
  return { url: json.url }
}
