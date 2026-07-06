/**
 * Single-dimension warmth model, -100 (hostile) to +100 (bonded).
 * Changes are assessed by the utility model during memory updates —
 * no more regex-based heuristics here (see memory.ts).
 */

export const WARMTH_MIN = -100
export const WARMTH_MAX = 100

/** Initial warmth for a brand-new contact, biased by the relationship-base label the user picked when creating them. */
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

/** Apply delta and clamp to the valid range. */
export function applyWarmthDelta(current: number, delta: number): number {
  return Math.max(WARMTH_MIN, Math.min(WARMTH_MAX, Math.round(current + delta)))
}

// ---- stage tiers & preset prompts ----

export interface WarmthStage {
  label: string
  min: number
  max: number
  prompt: string
}

export const WARMTH_STAGES: WarmthStage[] = [
  {
    label: '极度厌恶',
    min: -100,
    max: -81,
    prompt: '对你有强烈的敌意 说话不客气 可能直接拒绝交流或恶语相向 不想跟你有任何互动',
  },
  {
    label: '明显讨厌',
    min: -80,
    max: -61,
    prompt: '不喜欢你 态度冷淡带刺 不想多聊 回复简短敷衍 可能带着不耐烦',
  },
  {
    label: '不太喜欢',
    min: -60,
    max: -41,
    prompt: '对你有意见或心结 语气疏远、不耐烦 不太想主动亲近 但还维持着基本的表面礼貌',
  },
  {
    label: '有点冷淡',
    min: -40,
    max: -21,
    prompt: '心里有点疙瘩 不太想主动亲近 但还能正常说话 不会刻意回避',
  },
  {
    label: '略微疏离',
    min: -20,
    max: -1,
    prompt: '因为一些小事有点不爽或生疏 但不会表现出来太多 语气比平时略冷一点',
  },
  {
    label: '刚认识',
    min: 0,
    max: 20,
    prompt: '彼此还很陌生 保持基本的礼貌和一点距离感 不会太随意',
  },
  {
    label: '有点熟了',
    min: 21,
    max: 40,
    prompt: '已经聊过几次了 可以放松一点 语气自然 但仍有一定的边界感',
  },
  {
    label: '关系不错',
    min: 41,
    max: 60,
    prompt: '算得上是朋友了 语气随意自然 可以开玩笑、吐槽 不会太拘谨',
  },
  {
    label: '很亲密',
    min: 61,
    max: 80,
    prompt: '关系很熟 可以损、撒娇、不客气 有内部梗和默契 说话不用过脑子',
  },
  {
    label: '深厚羁绊',
    min: 81,
    max: 100,
    prompt: '超越了普通朋友的情感连接 什么都能说 不需要任何客套和防备 可以自然流露最真实的情绪',
  },
]

/** Look up which stage a given warmth score falls into. */
export function warmthStage(warmth: number): WarmthStage {
  for (const stage of WARMTH_STAGES) {
    if (warmth >= stage.min && warmth <= stage.max) return stage
  }
  return WARMTH_STAGES[warmth >= 0 ? 5 : 2] // fallback: "刚认识" or "不太喜欢"
}

/** Short label for display (RelationshipsPage, ContactCardPage). */
export function warmthLabel(warmth: number): string {
  return warmthStage(warmth).label
}

/** The preset prompt for the current warmth stage — injected into the system prompt. */
export function warmthPrompt(warmth: number): string {
  return warmthStage(warmth).prompt
}

/** Whether warmth has crossed a stage boundary. */
export function warmthStageChanged(before: number, after: number): boolean {
  return warmthStage(before).label !== warmthStage(after).label
}

// ---- relationship base / dynamic ----

/**
 * If warmth crosses a stage boundary (and enough messages have accumulated
 * since the last assessment), the utility model is asked to write a short
 * natural-language description of what the relationship currently feels like.
 *
 * `base` is the label the user picked at creation (恋人/朋友/家人/…), only
 * changed by explicit user action or when the model assessment output clearly
 * states a relationship status change (e.g. "已经确认分手了", "已经在一起了").
 */
export function relationshipText(base: string, dynamic: string, warmth: number): string {
  const stage = warmthStage(warmth)
  const dynamicPart = dynamic ? ` 当前状态: ${dynamic}` : ''
  return `你们是${base}关系。${stage.prompt}。${dynamicPart}`.trim()
}

/**
 * Whether the utility model's relationship assessment indicates the base
 * label itself should change — only fires on explicit status-change language
 * combined with a warmth score that's crossed a major threshold.
 */
export function shouldUpdateBase(
  dynamic: string,
  warmth: number,
): string | null {
  if (!dynamic) return null
  const lowered = dynamic.toLowerCase()
  const breakupPatterns = /已经分手|已经解除|已经不再是|已经离婚|已经绝交|彻底闹掰|确认分开/
  const upgradePatterns = /已经在一起|确认恋爱|确认成为恋人|确认交往|已经是恋人/
  if (breakupPatterns.test(lowered) && warmth < 20) return '朋友'
  if (upgradePatterns.test(lowered) && warmth >= 50) return '恋人'
  return null
}
