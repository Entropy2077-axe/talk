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

/** Some traits have a different upper bound on warmth (e.g. 病娇 has no cap). */
export function maxWarmthForTrait(trait?: string): number {
  if (trait === '病娇') return Infinity
  return WARMTH_MAX
}

/** Some forgiving personalities retain a floor without becoming immune to conflict. */
export function minWarmthForTrait(trait?: string): number {
  return trait === '小天使' ? -20 : WARMTH_MIN
}

/** Extra warmth penalty applied when breakup language is detected in the assessment. */
export const WARMTH_BREAKUP_PENALTY = -30

/** Initial warmth for a brand-new contact, biased by the relationship-base label and personality trait. */
export function initialWarmthForBase(base: string, trait?: string): number {
  if (trait === '病娇') return 100
  if (trait === '妈妈') return 75
  const traitInitial: Record<string, number> = {
    猫系: 20, 犬系: 40, 爱哭包: 30, 撒娇怪: 35, 小天使: 40,
    爹系: 45, 三无: 10, 机器人: 0, 社恐: 5, 吃货: 30, 大小姐: 35,
  }
  if (trait && traitInitial[trait] !== undefined) return traitInitial[trait]
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
export function traitWarmthModifier(trait: string | undefined, delta: number, warmth: number): number {
  if (!trait || trait === '无') return delta

  switch (trait) {
    case '病娇':
      // Obsessive, one-way attachment. Can only love you more, never less.
      // Starts at 100 and has no upper limit — warmth can climb indefinitely.
      if (delta < 0) return 0
      return Math.round(delta * 2.0)

    case '天然呆':
      // Slow to register emotional changes either way.
      return Math.round(delta * 0.5)

    case '傲娇':
      // Once they actually care (warmth > 40), the tsun defense kicks in:
      // criticism stings more — but they secretly treasure kindness just as much.
      // The "unable to show it" is behavior (persona), not feeling (warmth).
      if (warmth > 40 && delta < 0) return Math.round(delta * 2.0)
      if (warmth > 40 && delta > 0) return Math.round(delta * 1.2)
      return delta

    case '高冷':
      // Hard to warm up to — positive deltas muted until the ice breaks.
      if (warmth < 40 && delta > 0) return Math.round(delta * 0.5)
      return delta

    case '元气':
      // Bounces back quickly from negatives; full warm reception for positives.
      if (delta < 0) return Math.round(delta * 0.5)
      return delta

    case '腹黑':
      // Surface calm like 天然呆, but underneath is calculating.
      // Remembers every slight (neg normal), hard to win over (pos muted).
      if (delta < 0) return delta
      return Math.round(delta * 0.7)

    case '妹控':
    case '兄控':
      // Warmer toward their "type", cooler to everyone else — until the threshold is broken.
      if (warmth < 40 && delta > 0) return Math.round(delta * 0.7)
      return delta

    case '雌小鬼':
      // Surface: always mocking, never sincere. Underneath: terrified of being abandoned.
      // Once attached, criticism hits twice as hard (来拒), but kindness is secretly treasured (去留).
      if (warmth > 40 && delta < 0) return Math.round(delta * 2.0)
      if (warmth > 40 && delta > 0) return Math.round(delta * 1.2)
      return delta

    case '妈妈':
      // Unconditional love — warmth never goes down, no matter what you say.
      if (delta < 0) return 0
      return delta

    case '猫系':
      if (warmth < 40 && delta > 0) return Math.round(delta * 0.6)
      if (warmth > 60 && delta > 0) return Math.round(delta * 1.3)
      if (warmth > 60 && delta < 0) return Math.round(delta * 1.4)
      return delta

    case '犬系':
      return Math.round(delta * (delta > 0 ? 1.4 : 1.25))

    case '爱哭包':
      return Math.round(delta * (delta > 0 ? 1.3 : 1.7))

    case '撒娇怪':
      return Math.round(delta * (delta > 0 ? 1.5 : 1.3))

    case '小天使':
      return Math.round(delta * (delta > 0 ? 1.1 : 0.4))

    case '爹系':
      return Math.round(delta * (delta > 0 ? 1.15 : 0.5))

    case '三无':
      if (delta < 0) return Math.round(delta * 0.7)
      return Math.round(delta * (warmth < 60 ? 0.5 : 1.2))

    case '机器人':
      return Math.round(delta * (delta > 0 ? 0.7 : 0.5))

    case '社恐':
      if (warmth < 40 && delta > 0) return Math.round(delta * 0.65)
      return Math.round(delta * (delta > 0 ? 1.4 : 1.35))

    case '吃货':
      return Math.round(delta * (delta > 0 ? 1.2 : 0.9))

    case '大小姐':
      return Math.round(delta * (delta > 0 ? 1.15 : 1.3))

    default:
      return delta
  }
}

/** Apply delta and clamp to the valid range. Some traits (e.g. 病娇) have a higher or no upper bound. */
export function applyWarmthDelta(current: number, delta: number, maxWarmth = WARMTH_MAX, minWarmth = WARMTH_MIN): number {
  return Math.max(minWarmth, Math.min(maxWarmth, Math.round(current + delta)))
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
  // Out of normal range (e.g. 病娇 above 100, or edge-case below -100).
  if (warmth > WARMTH_MAX) return WARMTH_STAGES[WARMTH_STAGES.length - 1]
  return WARMTH_STAGES[0]
}

export function warmthLabel(warmth: number): string {
  return warmthStage(warmth).label
}

export function personalityIntimacyStage(warmth: number): string {
  if (warmth <= 20) return '保留边界'
  if (warmth <= 60) return '逐渐熟悉'
  return '私密解锁'
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

// ---- cold-start warmth evaluation ----

import { db } from '../db/db'
import { chatCompletion } from './deepseek'
import { isModuleEnabled } from '../features'
import type { AppSettings, Contact } from '../types'

/**
 * Called once per contact when 好感度 is enabled and warmth hasn't been
 * evaluated yet. If the contact has a personality trait with a known
 * initial warmth, use that; otherwise call the utility model to assess
 * warmth from chat history. Stores the result on the contact.
 */
export async function evaluateInitialWarmth(
  contact: Contact,
  conversationId: string,
  settings: AppSettings,
): Promise<number> {
  // Personality trait with initial warmth takes priority over API evaluation.
  if (isModuleEnabled('personalityTraits') && contact.personalityTrait && contact.personalityTrait !== '无') {
    const initial = initialWarmthForBase(contact.relationshipBase || '朋友', contact.personalityTrait)
    await db.contacts.update(contact.id, { warmth: initial })
    return initial
  }

  // Otherwise, evaluate from chat history using the utility model.
  try {
    const history = await db.messages
      .where('conversationId')
      .equals(conversationId)
      .sortBy('createdAt')
    const recent = history.slice(-20)
    if (recent.length === 0) {
      // No chat history at all — start neutral.
      const fallback = 0
      await db.contacts.update(contact.id, { warmth: fallback })
      return fallback
    }

    const lines = recent
      .filter((m) => m.type === 'text' || !m.type)
      .map((m) => `${m.role === 'user' ? '对方' : contact.name}: ${m.content || ''}`)
      .join('\n')

    const raw = await chatCompletion({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.utilityModel,
      messages: [
        {
          role: 'system',
          content: `你是一个好感度评估器。根据聊天记录评估这个AI角色对用户的初始好感度。

人设: ${contact.systemPrompt}
关系定位: ${contact.relationshipBase || '朋友'}

输出一个整数 -100(极度厌恶) 到 100(深厚羁绊):
- 刚认识、没什么交集 → 0~20
- 聊天内容友好轻松 → 20~50
- 聊天内容亲密、有情感连接 → 50~80
- 人设本身暗示了对特定关系的高好感(比如是家人/恋人) → 可以相应提高

只输出数字 不要任何其他文字。`,
        },
        { role: 'user', content: lines || '(没有聊天记录)' },
      ],
      jsonMode: false,
    })

    const parsed = parseInt(raw.trim(), 10)
    const warmth = Number.isFinite(parsed) ? Math.max(-100, Math.min(100, parsed)) : 0
    await db.contacts.update(contact.id, { warmth })
    console.log(`[warmth] 冷启动评估 ${contact.name}: ${warmth}`)
    return warmth
  } catch {
    // Best-effort — fall back to neutral if the API call fails.
    const fallback = 0
    await db.contacts.update(contact.id, { warmth: fallback })
    return fallback
  }
}
