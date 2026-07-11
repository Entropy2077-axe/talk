import type { CustomPersonalityTrait } from '../types'

export function customTraitsValidationError(traits: CustomPersonalityTrait[]): string | null {
  const invalid = traits.some((trait) => !trait.name.trim() || !trait.meaning.trim() || trait.rules.some((rule) => rule.minWarmth > rule.maxWarmth || rule.positiveMultiplier < 0 || rule.positiveMultiplier > 10 || rule.negativeMultiplier < 0 || rule.negativeMultiplier > 10))
  return invalid ? '自定义特质需要名称和含义，区间必须有效，倍率需在 0–10 之间' : null
}

export function hasOverlappingCustomTraitRules(trait: CustomPersonalityTrait): boolean {
  return trait.rules.some((rule, index) => trait.rules.some((other, otherIndex) => otherIndex > index && rule.minWarmth <= other.maxWarmth && other.minWarmth <= rule.maxWarmth))
}
