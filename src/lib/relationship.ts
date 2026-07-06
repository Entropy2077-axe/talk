/**
 * Single-dimension warmth model, -100 (hostile) to +100 (bonded).
 * Changes are assessed by the utility model during memory updates.
 *
 * Warmth stages are purely for display ("好感度: 52 · 关系不错") — they
 * don't gate any logic. Relationship changes are driven by the assessment
 * text and warmth value directly.
 */

export const WARMTH_MIN = -100
export const WARMTH_MAX = 100

/** Extra warmth penalty applied when breakup language is detected in the assessment. */
export const WARMTH_BREAKUP_PENALTY = -30

/** Initial warmth for a brand-new contact, biased by the relationship-base label. */
export function initialWarmthForBase(base: string): number {
  switch (base) {
    case '恋人':
      return 60
    case '暧昧对象':
      return 35
    case '家人':
      return 55
    case '朋友':
      return 30
    case '损友':
      return 25
    case '前辈/同事':
      return 15
    default:
      return 0
  }
}

/** Clamp a warmth change to [-5, +5] so no single memory update swings it too far. */
export function clampWarmthDelta(delta: number): number {
  return Math.max(-5, Math.min(5, Math.round(delta)))
}

/**
 * Apply a personality trait modifier to the warmth delta.
 * Currently a pass-through — when traits like 'yandere' (病娇) or 'airhead'
 * (天然呆) are implemented, this is where per-trait delta scaling happens.
 *
 * Hook shape for future traits:
 *   yandere → negative deltas halved, positive deltas doubled
 *   airhead → all deltas halved (slow to change)
 *   tsundere → negative deltas doubled when warmth > 40 (defensive)
 */
export function traitWarmthModifier(_trait: string | undefined, delta: number): number {
  // Pass-through: no trait modifiers implemented yet.
  // When adding a trait, return the modified delta here.
  return delta
}

/** Apply delta and clamp to the valid range. */
export function applyWarmthDelta(current: number, delta: number): number {
  return Math.max(WARMTH_MIN, Math.min(WARMTH_MAX, Math.round(current + delta)))
}

// ---- stage tiers (display only) ----

export interface WarmthStage {
  label: string
  min: number
  max: number
  prompt: string
}

export const WARMTH_STAGES: WarmthStage[] = [
  { label: '极度厌恶', min: -100, max: -81, prompt: '对你有强烈的敌意 说话不客气 可能直接拒绝交流或恶语相向' },
  { label: '明显讨厌', min: -80, max: -61, prompt: '不喜欢你 态度冷淡带刺 不想多聊 回复简短敷衍' },
  { label: '不太喜欢', min: -60, max: -41, prompt: '对你有意见或心结 语气疏远不耐烦 维持表面礼貌' },
  { label: '有点冷淡', min: -40, max: -21, prompt: '心里有点疙瘩 不太想主动亲近 但还能正常说话' },
  { label: '略微疏离', min: -20, max: -1, prompt: '因为小事有点不爽 但不会表现出来太多 语气比平时略冷' },
  { label: '刚认识', min: 0, max: 20, prompt: '彼此还很陌生 保持基本礼貌和距离感 不会太随意' },
  { label: '有点熟了', min: 21, max: 40, prompt: '已经聊过几次了 可以放松一点 语气自然 仍有边界感' },
  { label: '关系不错', min: 41, max: 60, prompt: '算得上是朋友了 语气随意自然 可以开玩笑吐槽' },
  { label: '很亲密', min: 61, max: 80, prompt: '关系很熟 可以损、撒娇、不客气 有内部梗和默契' },
  { label: '深厚羁绊', min: 81, max: 100, prompt: '超越了普通朋友的情感连接 什么都能说 不需要客套和防备' },
]

export function warmthStage(warmth: number): WarmthStage {
  for (const stage of WARMTH_STAGES) {
    if (warmth >= stage.min && warmth <= stage.max) return stage
  }
  return WARMTH_STAGES[warmth >= 0 ? 5 : 2]
}

export function warmthLabel(warmth: number): string {
  return warmthStage(warmth).label
}

export function warmthPrompt(warmth: number): string {
  return warmthStage(warmth).prompt
}

// ---- breakup detection ----

const BREAKUP_PATTERN = /已经分手|已经解除|已经不再是|已经离婚|已经绝交|彻底闹掰|确认分开|分手了|已经分了|关系破裂|闹翻了|掰了|结束了|到此为止|不想再继续|彻底完了|没戏了|拉黑了|删好友了|断绝|一刀两断|恩断义绝|决裂|一拍两散|形同陌路/
const UPGRADE_PATTERN = /已经在一起|确认恋爱|确认成为恋人|确认交往|已经是恋人|在一起了|确定了关系|从暧昧升级|正式交往|官宣|表白.*接受了|表白.*答应了/

/** True if the assessment text describes a recent breakup/separation. */
export function containsBreakupLanguage(dynamic: string): boolean {
  if (!dynamic) return false
  return BREAKUP_PATTERN.test(dynamic)
}

/** True if the assessment text describes a confirmed upgrade to romantic relationship. */
export function containsUpgradeLanguage(dynamic: string): boolean {
  if (!dynamic) return false
  return UPGRADE_PATTERN.test(dynamic)
}

// ---- relationship base / dynamic ----

/**
 * Build the single relationship line injected into the system prompt.
 * When breakup is detected, prominently flag it so the model doesn't
 * act like nothing happened.
 */
export function relationshipLine(
  base: string,
  dynamic: string,
  warmth: number,
): string {
  const stage = warmthStage(warmth)
  const parts: string[] = [`你们是${base}关系。${stage.prompt}`]
  if (dynamic) {
    const prefix = containsBreakupLanguage(dynamic) ? '⚠️ ' : ''
    parts.push(`当前状态: ${prefix}${dynamic}`)
    if (containsBreakupLanguage(dynamic)) {
      parts.push('注意：关系刚刚破裂 你的语气必须体现这一点 不能表现得像什么都没发生过一样若无其事')
    }
  }
  return parts.join('。')
}

/**
 * Whether the base label should change — only fires on explicit
 * status-change language combined with the right warmth threshold.
 */
export function shouldUpdateBase(dynamic: string, warmth: number): string | null {
  if (!dynamic) return null
  if (BREAKUP_PATTERN.test(dynamic) && warmth < 20) return '朋友'
  if (UPGRADE_PATTERN.test(dynamic) && warmth >= 50) return '恋人'
  return null
}
