/**
 * Which "style" of avatar photo fits a new contact — decided entirely in
 * code from their personality tags (weighted random), same philosophy as
 * moments/group-speaker-selection: the model never picks this, it only
 * later supplies a search keyword suited to whichever category code chose.
 * Matches how real people actually pick chat avatars: anime pictures,
 * scenery, an attractive stranger's photo, or a pet — hardly ever their
 * own face.
 */
export type AvatarCategory = 'anime' | 'landscape' | 'person' | 'pet'

const BASE_WEIGHT = 1

const TAG_CATEGORY_WEIGHTS: Record<string, Partial<Record<AvatarCategory, number>>> = {
  开朗活泼: { pet: 2, anime: 1 },
  高冷禁欲: { landscape: 3, person: 1 },
  温柔体贴: { pet: 2, person: 1 },
  毒舌吐槽: { person: 2, anime: 1 },
  文艺敏感: { landscape: 3 },
  幽默搞笑: { anime: 2, pet: 1 },
  沉稳成熟: { landscape: 2, person: 1 },
  软萌粘人: { pet: 3, anime: 1 },
  独立飒爽: { person: 2, landscape: 1 },
  话痨: { anime: 1, pet: 1, person: 1 },
  慢热: { landscape: 2 },
  中二: { anime: 3 },
}

/** Custom/unrecognized tags (user-typed, or from the 🎲 random-trait picker) just fall back to the base weight for every category — no crash, no special-casing needed. */
export function pickAvatarCategory(tags: string[]): AvatarCategory {
  const weights: Record<AvatarCategory, number> = {
    anime: BASE_WEIGHT,
    landscape: BASE_WEIGHT,
    person: BASE_WEIGHT,
    pet: BASE_WEIGHT,
  }
  for (const tag of tags) {
    const tagWeights = TAG_CATEGORY_WEIGHTS[tag]
    if (!tagWeights) continue
    for (const key of Object.keys(tagWeights) as AvatarCategory[]) {
      weights[key] += tagWeights[key] ?? 0
    }
  }

  const total = weights.anime + weights.landscape + weights.person + weights.pet
  let r = Math.random() * total
  for (const category of Object.keys(weights) as AvatarCategory[]) {
    r -= weights[category]
    if (r <= 0) return category
  }
  return 'landscape'
}
