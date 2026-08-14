import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { isAiTestId } from './aiTestIsolation'
import { parseJsonLoose } from './aiProtocol'
import { chatCompletionText as chatCompletion } from './deepseek'
import { momentReactionProbability, uniqueRelationPairs } from './contactRelations'
import { describeCurrentSchedule, isPhoneAvailable } from './schedule'
import { randomAnimeAvatar, searchPexelsPhoto } from './photoSearch'
import { createMediaAsset, startMediaAsset } from './imageAssets'
import { isImageProviderReady } from './mediaProviders'
import { recordSocialEvent } from './socialEvents'
import { displayName } from './contact'
import { retrieveWorldbookContext } from './worldbook'
import { recentMemoriesText, socialMemoriesText } from './memory'
import { recentSocialEventsText } from './socialEvents'
import { recentSharedOriginalContext } from './sharedRecentContext'
import { parseTurnLogicReview } from './turnLogicReviewer'
import type { AppSettings, Contact, Moment } from '../types'
import { featureActive, getPromptTemplate, promptModuleEnabled } from './promptModules'
import { useSettingsStore } from '../store/useSettingsStore'

/** Of the friends who *do* react (relationship allows it and the dice roll passed), this fraction also leave a comment instead of just liking. */
const COMMENT_SHARE = 0.55
/** Even a friend/good relationship has a chance of just scrolling past without reacting at all. */
/** Not every moment gets a photo — matches real WeChat moments where plenty of posts are text-only. Decided in code before the model even writes the content, same "code decides, model fills in" split as everywhere else. */
const MOMENT_PHOTO_PROBABILITY = 0.6
const MOMENT_COOLDOWN_MS = 3 * 60 * 60 * 1000
const MOMENT_HISTORY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000
const MOMENT_HISTORY_LIMIT = 7

const COMMENT_STICKER_PATTERN = /\[sticker:([^[\]]+)\]/i

/**
 * AI comments are asked to append a "[sticker:名字]" marker at the end of the
 * text (see the sticker instructions in buildMomentsPrompt/
 * buildUserMomentCommentPrompt below), but — same lesson as the commission
 * bracket-leak and group-chat name-prefix-leak bugs — a prompt instruction
 * alone isn't reliable: the model sometimes drops the marker mid-sentence
 * instead of at the end (confirmed via a real user report), which an
 * end-anchored regex would silently fail to match at all, leaving the raw
 * "[sticker:xxx]" text visible. So this matches the marker ANYWHERE in the
 * string, not just at the end. Only rendered as an actual sticker if the
 * name matches one that still exists (stickers can be renamed/deleted after
 * the comment was generated), otherwise the raw text is left completely
 * untouched rather than silently eating content on a stale name.
 */
export function parseCommentSticker(content: string, validStickerNames: string[]): { text: string; stickerName?: string } {
  const match = content.match(COMMENT_STICKER_PATTERN)
  if (!match || match.index === undefined) return { text: content }
  const name = match[1].trim()
  if (!validStickerNames.includes(name)) return { text: content }
  const before = content.slice(0, match.index)
  const after = content.slice(match.index + match[0].length)
  const text = `${before} ${after}`.replace(/\s{2,}/g, ' ').trim()
  return { text, stickerName: name }
}

function stickerCommentInstruction(stickerNames: string[]): string {
  if (stickerNames.length === 0) return ''
  return `\n可用表情包(仅评论可以用 朋友圈正文本身不要用): ${stickerNames.join('、')}\n如果某条评论配一个表情包会更生动 可以在该条评论文字**说完之后、最后面**加上"[sticker:表情名字]"(表情名字必须是上面列表里的一个 一字不差 只能加在整句话的最后 不能插在句子中间 不需要就不加 大部分评论不需要)\n`
}

function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

export function eligiblePosters(contacts: Contact[], now: number): Contact[] {
  const nowDate = new Date(now)
  return contacts.filter(
    (c) => (!c.lastMomentAt || now - c.lastMomentAt > MOMENT_COOLDOWN_MS) && isPhoneAvailable(c, nowDate),
  )
}

function normalizeMomentText(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
}

function bigrams(value: string): Set<string> {
  const result = new Set<string>()
  for (let index = 0; index < value.length - 1; index++) result.add(value.slice(index, index + 2))
  return result
}

/** A deterministic final guard; LLM review is useful but must never be the only duplicate protection. */
export function momentNoveltyIssue(content: string, history: Pick<Moment, 'content'>[]): string | null {
  const normalized = normalizeMomentText(content)
  if (!normalized) return '动态正文为空。'
  for (const item of history) {
    const previous = normalizeMomentText(item.content)
    if (!previous) continue
    if (previous === normalized) return `与近期动态完全相同：“${item.content.slice(0, 80)}”`
    if (Math.min(previous.length, normalized.length) >= 12 && (previous.includes(normalized) || normalized.includes(previous))) return `与近期动态几乎是同一句话：“${item.content.slice(0, 80)}”`
    const a = bigrams(previous)
    const b = bigrams(normalized)
    const common = [...a].filter((part) => b.has(part)).length
    if (Math.min(previous.length, normalized.length) >= 18 && (2 * common) / Math.max(1, a.size + b.size) >= 0.82) return `与近期动态题材和表达高度相似：“${item.content.slice(0, 80)}”`
  }
  return null
}

async function recentMomentsFor(contactId: string, now = Date.now()): Promise<Moment[]> {
  const rows = await db.moments.where('contactId').equals(contactId).toArray()
  return rows.filter((item) => item.createdAt >= now - MOMENT_HISTORY_WINDOW_MS).sort((a, b) => b.createdAt - a.createdAt).slice(0, MOMENT_HISTORY_LIMIT)
}

/** Shared guard for every automatic source that writes an AI moment. */
export async function canPublishNovelMoment(contactId: string, content: string, at = Date.now()): Promise<boolean> {
  return !momentNoveltyIssue(content, await recentMomentsFor(contactId, at))
}

function recentMomentHistoryText(rows: Moment[]): string {
  return rows.length ? rows.map((item) => `${new Date(item.createdAt).toLocaleString()}：${item.content}`).join('\n') : '（近 14 天没有已发布动态，可自由选择真实、公开的日常题材。）'
}

/**
 * How many of the eligible contacts should post this round. Per spec: pick
 * a random count strictly between 1 and the user's total contact count —
 * but if more than 5 contacts are eligible, cap the upper bound at 5
 * instead (so a big friend list doesn't make every refresh flood the feed).
 */
export function pickPosterCount(eligibleCount: number, totalContacts: number, maxCount = 5): number {
  if (eligibleCount <= 0) return 0
  const upperExclusive = Math.min(maxCount, eligibleCount > 5 ? 5 : totalContacts)
  const count = upperExclusive > 2 ? 2 + Math.floor(Math.random() * (upperExclusive - 2)) : 1
  return Math.max(1, Math.min(count, eligibleCount))
}

interface ReactorPlan {
  contact: Contact
  willComment: boolean
  relationLabel: string
  relationContext: string
}

/** For one posting contact, decides (via the relationship graph + dice rolls, not the LLM) which of their linked friends react, and whether each reaction includes a comment. */
async function planReactors(poster: Contact, contactsById: Map<string, Contact>): Promise<ReactorPlan[]> {
  const relationRows = await db.contactRelations
    .where('fromContactId')
    .equals(poster.id)
    .or('toContactId')
    .equals(poster.id)
    .toArray()
  const links = uniqueRelationPairs(relationRows)

  const candidates: { contact: Contact; relationLabel: string; link: { label: import('../types').ContactRelationLabel; affinity?: number; familiarity?: number; tension?: number; dynamicSummary?: string } }[] = []
  for (const link of links) {
    const otherId = link.fromContactId === poster.id ? link.toContactId : link.fromContactId
    const other = contactsById.get(otherId)
    if (other) candidates.push({ contact: other, relationLabel: link.label || '普通朋友', link })
  }

  const plans: ReactorPlan[] = []
  for (const candidate of candidates) {
    if (Math.random() > momentReactionProbability(candidate.link)) continue
    plans.push({
      contact: candidate.contact,
      willComment: Math.random() < Math.min(0.82, COMMENT_SHARE + Math.max(-0.25, (candidate.link.affinity ?? 0) / 280) - Math.max(0, candidate.link.tension ?? 0) / 350),
      relationLabel: candidate.relationLabel || '普通朋友',
      relationContext: candidate.link.dynamicSummary || '暂无额外动态',
    })
  }
  return plans
}

function buildMomentsPrompt(
  entries: { poster: Contact; commenters: ReactorPlan[]; willHavePhoto: boolean }[],
  worldviewText: string,
  stickerNames: string[],
  contexts: Map<string, string>,
  settings: AppSettings,
): string {
  const now = new Date()
  const sections = entries
    .map((e, i) => {
      const commenterLines =
        e.commenters.length > 0
          ? e.commenters
              .filter((c) => c.willComment)
              .map(
                (c, j) =>
                  `  评论者${j + 1}: ${c.contact.name}\n  人设: ${c.contact.systemPrompt}\n  与发布者的关系: ${c.relationLabel || '普通朋友'}；${c.relationContext}\n  最近可用素材: ${contexts.get(c.contact.id) || '无'}`,
              )
              .join('\n')
          : '  （这条没有人评论）'
      const scheduleLine = describeCurrentSchedule(e.poster, now)
      const statusLine = scheduleLine ? `${e.poster.name}${scheduleLine} (内容可以但不强制符合这个状态)\n` : ''
      const photoLine = e.willHavePhoto
        ? `这条动态会配一张照片。填写 imageKeyword（具体英文画面描述）、imageKind（selfie/portrait/scene/object）和 includePoster（照片是否出现发布者本人）。只有本人确实入镜时 includePoster 才为 true。\n`
        : ''
      return `人物${i + 1}: ${e.poster.name}\n人设: ${e.poster.systemPrompt}\n当前心情: ${e.poster.mood?.text || '平静'}\n最近可用素材: ${contexts.get(e.poster.id) || '无'}\n${statusLine}${photoLine}这条朋友圈下会评论的人(按顺序):\n${commenterLines}`
    })
    .join('\n\n')

  const worldviewSection = worldviewText ? `${worldviewText}\n\n` : ''

  const editable = getPromptTemplate(settings, 'moments', 'generation', { momentContext: `${worldviewSection}${stickerCommentInstruction(stickerNames)}\n${sections}` }) ?? ''
  return `${editable}\n\n固定输出协议：只输出JSON {"moments":[{"content":"人物1动态","imageKeyword":"需要配图才填写","imageKind":"selfie|portrait|scene|object","includePoster":true,"comments":["评论者1评论"]}]}。moments及comments必须与输入顺序和数量一致。`
}

interface ParsedMoment {
  content: string
  comments: string[]
  imageKeyword: string
  imageKind: import('../types').AiImageKind
  includePoster: boolean
}

function parseMomentsResponse(raw: string, expected: number[]): ParsedMoment[] | null {
  const parsed = parseJsonLoose<{ moments?: unknown[] }>(raw)
  if (!parsed || !Array.isArray(parsed.moments) || parsed.moments.length !== expected.length) return null
  const result: ParsedMoment[] = []
  for (let i = 0; i < parsed.moments.length; i++) {
    const value = parsed.moments[i]
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const m = value as Record<string, unknown>
    if (typeof m.content !== 'string' || !m.content.trim()) return null
    const comments: string[] = Array.isArray(m.comments)
      ? m.comments.filter((c: unknown): c is string => typeof c === 'string' && c.trim().length > 0)
      : []
    const imageKeyword = typeof m.imageKeyword === 'string' ? m.imageKeyword.trim() : ''
    const imageKind = ['selfie', 'portrait', 'scene', 'object'].includes(String(m.imageKind)) ? m.imageKind as import('../types').AiImageKind : 'scene'
    const includePoster = typeof m.includePoster === 'boolean' ? m.includePoster : imageKind === 'selfie' || imageKind === 'portrait'
    result.push({ content: m.content.trim(), comments, imageKeyword, imageKind, includePoster })
  }
  return result
}

/** Moments need their own review pass: broad feed context makes repeated hooks easy to miss. */
async function reviewMomentPayload(settings: AppSettings, raw: string, expectedShape: string, personaContext = ''): Promise<string> {
  try {
    const recent = await db.moments.orderBy('createdAt').reverse().limit(18).toArray()
    const history = recent.map((moment) => moment.content).join('\n').slice(0, 2200)
    const editableReview = getPromptTemplate(settings, 'moments', 'review', {
      personaContext: personaContext || '(无)',
      recentMoments: history || '(空)',
      candidate: raw.slice(0, 5000),
    }) ?? ''
    const judged = await chatCompletion({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.utilityModel || settings.model,
      jsonMode: true,
      thinking: 'disabled',
      temperature: 0,
      maxTokens: 220,
      purpose: 'quality',
      automatic: true,
      messages: [
        { role: 'system', content: `${editableReview}\n\n固定输出协议：候选JSON应符合 ${expectedShape}。只输出JSON：{"valid":true,"reason":""}` },
        { role: 'user', content: '请审查候选内容。' },
      ],
    })
    const verdict = parseTurnLogicReview(judged)
    if (verdict.status !== 'reject') {
      if (verdict.status === 'unavailable') console.warn(`[moments] 逻辑审查降级放行: ${verdict.reason}`)
      return raw
    }

    // The common path stays one small Flash call. Only a failed review pays
    // for a second call that mechanically repairs the required JSON shape.
    const editableRepair = getPromptTemplate(settings, 'moments', 'repair', {
      reviewReason: verdict.reason || '候选内容不符合要求',
      personaContext: personaContext || '(无)',
      candidate: raw.slice(0, 5000),
    }) ?? ''
    const repaired = await chatCompletion({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.utilityModel || settings.model,
      jsonMode: true,
      thinking: 'disabled',
      temperature: 0.15,
      maxTokens: 900,
      purpose: 'quality',
      automatic: true,
      messages: [
        { role: 'system', content: `${editableRepair}\n\n固定输出协议：只输出符合 ${expectedShape} 的JSON。` },
        { role: 'user', content: '请修复候选内容。' },
      ],
    })
    return repaired.trim() || raw
  } catch {
    return raw
  }
}

export interface RefreshMomentsResult {
  postedCount: number
  message?: string
}

/** Read-only test path: uses the production Moments prompt/parser/reviewer but never writes a Moment or social event. */
export async function runMomentTestSandbox(contact: Contact, settings: AppSettings, testInstruction: string): Promise<{ raw: string; reviewedRaw: string; parsed: unknown }> {
  if (!settings.apiKey) throw new Error('还没有配置API Key')
  if (!promptModuleEnabled(settings, 'moments')) throw new Error('朋友圈提示词模块已屏蔽')
  const stickerNames = (await db.stickers.toArray()).map((item) => item.name)
  const [privateMemories, socialMemories, events, originalContext] = await Promise.all([
    recentMemoriesText(contact.id, 4),
    socialMemoriesText(contact.id, 4),
    recentSocialEventsText([contact.id], 3, false),
    recentSharedOriginalContext([contact.id], settings.userNickname, { maxMessages: 45, maxChars: 6_500 }),
  ])
  const contexts = new Map([[contact.id, [originalContext, privateMemories, socialMemories, events, `【本次测试主题】${testInstruction}`].filter(Boolean).join('\n\n').slice(0, 10_500)]])
  const worldbookPrompt = featureActive(settings, 'worldview')
    ? (getPromptTemplate(settings, 'worldview', 'momentsRuntime', { worldbookEntries: await retrieveWorldbookContext(`${contact.name} ${contact.systemPrompt} ${contact.memoryFacts} ${testInstruction}`, { worldviewId: settings.activeWorldId || settings.defaultWorldviewId }) }) ?? '')
    : ''
  const entries = [{ poster: contact, commenters: [] as ReactorPlan[], willHavePhoto: true }]
  const raw = await chatCompletion({
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    model: settings.model,
    messages: [{ role: 'system', content: buildMomentsPrompt(entries, worldbookPrompt, stickerNames, contexts, settings) }, { role: 'user', content: '请生成' }],
    jsonMode: true,
    purpose: 'moments',
    automatic: false,
  })
  const personaContext = [worldbookPrompt, `Poster ${contact.name}: ${contact.systemPrompt}`].filter(Boolean).join('\n\n')
  const reviewedRaw = await reviewMomentPayload(settings, raw, '{"moments":[{"content":"...","imageKeyword":"...","comments":[]}]}', personaContext)
  return { raw, reviewedRaw, parsed: parseMomentsResponse(reviewedRaw, [0]) }
}

/**
 * The whole "who posts, who reacts" decision lives in code (per the user's
 * explicit request for a random system, not left to the model's whim) — the
 * single API call this makes is purely for writing the moment text and
 * comment text for whichever posters/reactors were already chosen.
 */
export async function refreshMoments(settings: AppSettings): Promise<RefreshMomentsResult> {
  if (!promptModuleEnabled(settings, 'moments')) return { postedCount: 0, message: '朋友圈提示词模块已屏蔽' }
  const startedAt = performance.now()
  const contacts = (await db.contacts.toArray()).filter((item) => !isAiTestId(item.id))
  if (contacts.length === 0) return { postedCount: 0, message: '还没有联系人' }
  if (!settings.apiKey) return { postedCount: 0, message: '还没有配置API Key' }

  const now = Date.now()
  const eligible = eligiblePosters(contacts, now)
  if (eligible.length === 0) return { postedCount: 0, message: '大家都刚发过 稍后再刷新试试' }

  const count = pickPosterCount(eligible.length, contacts.length, settings.proactiveMomentsMax)
  const shuffled = shuffle(eligible)
  const selectedWorldviewId = settings.activeWorldId || settings.defaultWorldviewId
  const posters = shuffled.slice(0, count)
  const contactsById = new Map(contacts.map((c) => [c.id, c]))

  const entries: { poster: Contact; commenters: ReactorPlan[]; willHavePhoto: boolean }[] = []
  for (const poster of posters) {
    const commenters = await planReactors(poster, contactsById)
    entries.push({ poster, commenters, willHavePhoto: Math.random() < MOMENT_PHOTO_PROBABILITY })
  }

  const stickerNames = (await db.stickers.toArray()).map((s) => s.name)
  const involved = Array.from(new Set(entries.flatMap((entry) => [entry.poster, ...entry.commenters.map((commenter) => commenter.contact)])))
  const contextRows = await Promise.all(involved.map(async (contact) => {
    const [privateMemories, socialMemories, events, originalContext] = await Promise.all([
      recentMemoriesText(contact.id, 4),
      socialMemoriesText(contact.id, 4),
      recentSocialEventsText([contact.id], 3, false),
      recentSharedOriginalContext([contact.id], settings.userNickname, { maxMessages: 45, maxChars: 6_500 }),
    ])
    return [contact.id, [originalContext, privateMemories, socialMemories, events].filter(Boolean).join('\n\n').slice(0, 10_500)] as const
  }))
  const contexts = new Map(contextRows)
  const historyRows = new Map(await Promise.all(posters.map(async (contact) => [contact.id, await recentMomentsFor(contact.id, now)] as const)))
  for (const poster of posters) {
    contexts.set(poster.id, `${contexts.get(poster.id) || ''}\n\n【近期本人动态：本次必须避让】\n${recentMomentHistoryText(historyRows.get(poster.id) || [])}`.slice(0, 12_000))
  }
  const momentsWorldbookPrompt =
    featureActive(settings, 'worldview')
      ? (getPromptTemplate(settings, 'worldview', 'momentsRuntime', {
          worldbookEntries: await retrieveWorldbookContext(entries.map((e) => `${e.poster.name} ${e.poster.systemPrompt} ${e.poster.memoryFacts}`).join('\n'), { worldviewId: selectedWorldviewId }),
        }) ?? '')
      : ''
  const raw = await chatCompletion({
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    model: settings.model,
    messages: [
      { role: 'system', content: buildMomentsPrompt(entries, momentsWorldbookPrompt, stickerNames, contexts, settings) },
      { role: 'user', content: '请生成' },
    ],
    jsonMode: true,
    purpose: 'moments',
    automatic: true,
  })
  console.info(`[moments-perf] 主模型完成=${Math.round(performance.now() - startedAt)}ms 条数=${entries.length}`)

  const expectedCommentCounts = entries.map((e) => e.commenters.filter((c) => c.willComment).length)
  const personaContext = [momentsWorldbookPrompt, entries.map((entry) => `Poster ${entry.poster.name}: ${entry.poster.systemPrompt}\nCommenters: ${entry.commenters.filter((commenter) => commenter.willComment).map((commenter) => `${commenter.contact.name}: ${commenter.contact.systemPrompt}`).join(' | ') || 'none'}`).join('\n\n')].filter(Boolean).join('\n\n')
  const reviewedRaw = await reviewMomentPayload(settings, raw, '{"moments":[{"content":"...","imageKeyword":"...","comments":["..."]}]}', personaContext)
  console.info(`[moments-perf] 自检完成=${Math.round(performance.now() - startedAt)}ms 条数=${entries.length}`)
  const parsed = parseMomentsResponse(reviewedRaw, expectedCommentCounts)
  if (!parsed) return { postedCount: 0, message: '生成失败 请再刷新试试' }

  // A rejected post is regenerated individually. This preserves successful
  // posters and gives the model a concrete correction instead of silently
  // dropping the entire refresh when the contact list is small.
  const finalParsed = [...parsed]
  let retryIndexes = finalParsed.flatMap((item, index) => momentNoveltyIssue(item.content, historyRows.get(entries[index].poster.id) || []) ? [index] : [])
  for (let attempt = 0; retryIndexes.length > 0 && attempt < 3; attempt++) {
    const retryEntries = retryIndexes.map((index) => entries[index])
    const retryContexts = new Map(contexts)
    for (const index of retryIndexes) {
      const issue = momentNoveltyIssue(finalParsed[index].content, historyRows.get(entries[index].poster.id) || []) || '本条没有换掉近期重复题材。'
      retryContexts.set(entries[index].poster.id, `【本次必须纠正】${issue}\n不得改几个字重发旧内容；必须换一个近期未使用的具体题材、场景或情绪落点。\n${contexts.get(entries[index].poster.id) || ''}`.slice(0, 12_000))
    }
    const retryRaw = await chatCompletion({
      apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.model, jsonMode: true, purpose: 'moments', automatic: true,
      messages: [{ role: 'system', content: buildMomentsPrompt(retryEntries, momentsWorldbookPrompt, stickerNames, retryContexts, settings) }, { role: 'user', content: '请根据【本次必须纠正】重新生成，并在输出前逐项检查。' }],
    })
    const retryReviewed = await reviewMomentPayload(settings, retryRaw, '{"moments":[{"content":"...","imageKeyword":"...","comments":["..."]}]}', personaContext)
    const retryParsed = parseMomentsResponse(retryReviewed, retryEntries.map((entry) => entry.commenters.filter((commenter) => commenter.willComment).length))
    if (!retryParsed) continue
    retryIndexes.forEach((index, retryIndex) => { finalParsed[index] = retryParsed[retryIndex] })
    retryIndexes = retryIndexes.filter((index) => !!momentNoveltyIssue(finalParsed[index].content, historyRows.get(entries[index].poster.id) || []))
  }

  let publishedCount = 0
  for (let i = 0; i < entries.length; i++) {
    const { poster, commenters, willHavePhoto } = entries[i]
    const { content, comments, imageKeyword, imageKind, includePoster } = finalParsed[i]
    // Never write an exact/high-similarity duplicate even if an upstream
    // model ignored every repair instruction. Other selected posters still publish.
    if (momentNoveltyIssue(content, historyRows.get(poster.id) || [])) continue
    const momentId = uuid()

    let imageUrl: string | undefined
    let imagePhotographer: string | undefined
    let imagePhotographerUrl: string | undefined
    if (willHavePhoto && imageKeyword && settings.momentsImageSource === 'pexels' && settings.pexelsApiKey) {
      try {
        const photo = await searchPexelsPhoto(settings.pexelsApiKey, imageKeyword, 'landscape')
        if (photo) {
          imageUrl = photo.url
          imagePhotographer = photo.photographer
          imagePhotographerUrl = photo.photographerUrl
        }
      } catch {
        // the photo is a nice-to-have; the moment text itself already succeeded
      }
    }
    if (willHavePhoto && settings.momentsImageSource === 'anime') {
      try {
        const image = await randomAnimeAvatar(settings.animeNsfwEnabled)
        if (image) imageUrl = image.url
      } catch {
        // Leave the Moment as text only when the optional gallery is unavailable.
      }
    }
    let imageAssetId: string | undefined
    if (willHavePhoto && imageKeyword && settings.momentsImageSource === 'generated' && isImageProviderReady(settings)) {
      try {
        const asset = await createMediaAsset({ origin: 'moment', originId: momentId, ownerContactIds: includePoster ? [poster.id] : [], scene: imageKeyword, kind: imageKind, settings, size: imageKind === 'selfie' || imageKind === 'portrait' ? '1024*1536' : '1536*1024' })
        imageAssetId = asset.id
      } catch {}
    }

    await db.moments.add({
      id: momentId,
      contactId: poster.id,
      content,
      createdAt: now + i,
      imageUrl,
      imageAssetId,
      imagePhotographer,
      imagePhotographerUrl,
    })
    if (imageAssetId) startMediaAsset(imageAssetId)
    publishedCount++
    await recordSocialEvent({
      type: 'moment_posted',
      actorId: poster.id,
      relatedContactIds: [poster.id],
      momentId,
      summary: `${poster.name}发了一条朋友圈: ${content}`,
      importance: 1,
      createdAt: now + i,
    })
    await db.contacts.update(poster.id, { lastMomentAt: now })

    let commentIndex = 0
    for (const reactor of commenters) {
      // everyone in the reactor plan reacts with at least a like
      await db.momentLikes.add({ id: uuid(), momentId, likerId: reactor.contact.id, createdAt: now })
      await recordSocialEvent({
        type: 'moment_liked',
        actorId: reactor.contact.id,
        targetId: poster.id,
        relatedContactIds: [reactor.contact.id, poster.id],
        momentId,
        summary: `${reactor.contact.name}赞了${poster.name}的朋友圈`,
        importance: 1,
        createdAt: now,
      })
      if (reactor.willComment) {
        const commentText = comments[commentIndex++]
        if (commentText) {
          await db.momentComments.add({
            id: uuid(),
            momentId,
            authorContactId: reactor.contact.id,
            content: commentText,
            createdAt: now,
          })
          await recordSocialEvent({
            type: 'moment_commented',
            actorId: reactor.contact.id,
            targetId: poster.id,
            relatedContactIds: [reactor.contact.id, poster.id],
            momentId,
            summary: `${reactor.contact.name}评论了${poster.name}的朋友圈: ${commentText}`,
            importance: 2,
            createdAt: now,
          })
        }
      }
    }
  }

  return { postedCount: publishedCount, message: publishedCount === 0 ? '本轮动态都需要重新构思，请稍后再刷新' : undefined }
}

/** Replaces an AI-authored post after the user gives a direction. Its old interaction
 * thread is intentionally reset: comments about the old text must not survive. */
export async function regenerateMoment(momentId: string, requirement: string, settings: AppSettings): Promise<void> {
  const moment = await db.moments.get(momentId)
  if (!moment || moment.contactId === 'user') throw new Error('只能重新生成 AI 发布的动态')
  if (!settings.apiKey) throw new Error('还没有配置 API Key')
  const poster = await db.contacts.get(moment.contactId)
  if (!poster) throw new Error('找不到动态发布者')
  const history = (await recentMomentsFor(poster.id)).filter((item) => item.id !== moment.id)
  const contexts = new Map([[poster.id, `【用户对本次重生成的要求】${requirement.trim() || '保持人设自然，换一个更合适的公开表达。'}\n【近期本人动态：必须避让】\n${recentMomentHistoryText(history)}`]])
  let parsed: ParsedMoment[] | null = null
  let correction = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await chatCompletion({
      apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.model, jsonMode: true, purpose: 'moments',
      messages: [{ role: 'system', content: buildMomentsPrompt([{ poster, commenters: [], willHavePhoto: false }], '', [], new Map([[poster.id, `${correction}${contexts.get(poster.id)}`]]), settings) }, { role: 'user', content: '请重新生成这条动态。必须优先服从用户要求。' }],
    })
    const reviewed = await reviewMomentPayload(settings, raw, '{"moments":[{"content":"...","imageKeyword":"...","comments":[]}]}', `Poster ${poster.name}: ${poster.systemPrompt}`)
    parsed = parseMomentsResponse(reviewed, [0])
    const issue = parsed?.[0] ? momentNoveltyIssue(parsed[0].content, history) : '输出格式不正确。'
    if (parsed?.[0] && !issue) break
    correction = `【本次必须纠正】${issue}\n不得改几个字重发旧内容，换一个近期未使用的题材。\n`
    parsed = null
  }
  if (!parsed?.[0]) throw new Error('重生成未能得到不重复的动态，请换一个要求再试')
  await db.transaction('rw', db.moments, db.momentComments, db.momentLikes, db.socialEvents, async () => {
    const commentIds = await db.momentComments.where('momentId').equals(momentId).primaryKeys()
    await db.momentComments.where('momentId').equals(momentId).delete()
    await db.momentLikes.where('momentId').equals(momentId).delete()
    const eventIds = await db.socialEvents.filter((event) => event.momentId === momentId || (!!event.messageId && commentIds.includes(event.messageId))).primaryKeys()
    if (eventIds.length) await db.socialEvents.bulkDelete(eventIds as string[])
    await db.moments.update(momentId, { content: parsed![0].content, imageUrl: undefined, imagePhotographer: undefined, imagePhotographerUrl: undefined })
    await recordSocialEvent({ type: 'moment_posted', actorId: poster.id, relatedContactIds: [poster.id], momentId, summary: `${poster.name}重新发布了一条朋友圈: ${parsed![0].content}`, importance: 1, createdAt: Date.now() })
  })
}

/** Rewrites one AI comment and clears replies that were written against its old text. */
export async function regenerateMomentComment(commentId: string, requirement: string, settings: AppSettings): Promise<void> {
  const comment = await db.momentComments.get(commentId)
  if (!comment || comment.authorContactId === 'user') throw new Error('只能重新生成 AI 跟评')
  if (!settings.apiKey) throw new Error('还没有配置 API Key')
  const [moment, author, allComments, contacts] = await Promise.all([db.moments.get(comment.momentId), db.contacts.get(comment.authorContactId), db.momentComments.where('momentId').equals(comment.momentId).sortBy('createdAt'), db.contacts.toArray()])
  if (!moment || !author) throw new Error('找不到原评论上下文')
  const names = new Map(contacts.map((contact) => [contact.id, contact.name]))
  const thread = allComments.map((item) => `${item.authorContactId === 'user' ? settings.userNickname || '用户' : names.get(item.authorContactId) || '某人'}: ${item.content}`).join('\n')
  const raw = await chatCompletion({
    apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.model, purpose: 'moments',
    messages: [{ role: 'system', content: buildMomentReplyPrompt(author, moment.content, [thread, `【用户对本次重生成的要求】${requirement.trim() || '更自然、更符合人设。'}`], '', [], '', settings) }, { role: 'user', content: '请只重写指定的这条跟评。' }],
  })
  const content = cleanPlainReply(raw).slice(0, 180)
  if (!content) throw new Error('没有生成有效跟评')
  await db.transaction('rw', db.momentComments, db.socialEvents, async () => {
    const descendants = allComments.filter((item) => item.replyToCommentId === commentId)
    if (descendants.length) await db.momentComments.bulkDelete(descendants.map((item) => item.id))
    const eventIds = await db.socialEvents.filter((event) => event.messageId === commentId || descendants.some((item) => item.id === event.messageId)).primaryKeys()
    if (eventIds.length) await db.socialEvents.bulkDelete(eventIds as string[])
    await db.momentComments.update(commentId, { content })
  })
}

/** How likely a contact is to react to the user's own moment — driven by warmth. */
function userMomentReactionProbability(warmth: number): number {
  return Math.min(0.9, Math.max(0.05, (warmth + 100) / 200))
}

interface UserMomentReactorPlan {
  contact: Contact
  willComment: boolean
}

function planUserMomentReactors(contacts: Contact[]): UserMomentReactorPlan[] {
  const plans: UserMomentReactorPlan[] = []
  for (const contact of contacts) {
    if (Math.random() > userMomentReactionProbability(contact.warmth ?? 0)) continue
    plans.push({ contact, willComment: Math.random() < COMMENT_SHARE })
  }
  return plans
}

function buildUserMomentCommentPrompt(content: string, commenters: Contact[], worldviewText: string, stickerNames: string[], contexts: Map<string, string>, settings: AppSettings): string {
  const now = new Date()
  const commenterLines = commenters
    .map((c, i) => {
      const scheduleLine = describeCurrentSchedule(c, now)
      return `评论者${i + 1}: ${c.name} 人设: ${c.systemPrompt}${scheduleLine ? ` ${scheduleLine}` : ''}\n和用户的关系: ${c.relationshipBase || '朋友'} ${c.relationshipDynamic || ''} 好感度:${c.warmth ?? 0} 当前心情:${c.mood?.text || '平静'}\n最近素材: ${contexts.get(c.id) || '无'}`
    })
    .join('\n')
  const worldviewSection = worldviewText ? `${worldviewText}\n\n` : ''
  const commentContext = `${worldviewSection}用户动态：${content}\n评论者：\n${commenterLines}\n${stickerCommentInstruction(stickerNames)}`
  const editable = getPromptTemplate(settings, 'moments', 'comments', { commentContext }) ?? ''
  return `${editable}\n\n固定输出协议：只输出JSON {"comments":["评论者1的评论","评论者2的评论"]}，数组顺序和数量必须与评论者一致。`
}

function parseCommentsResponse(raw: string, expectedCount: number): string[] | null {
  const parsed = parseJsonLoose<{ comments?: unknown[] }>(raw)
  if (!parsed || !Array.isArray(parsed.comments) || parsed.comments.length !== expectedCount) return null
  return parsed.comments.map((c: unknown) => (typeof c === 'string' ? c.trim() : ''))
}

/**
 * Posts a moment authored by the user themselves (contactId: 'user'), then
 * lets each contact independently roll to notice/like/comment based on their
 * relationship with the user — same shape as the AI-to-AI reaction system,
 * but probability comes from relationship dimensions since there's no
 * contactRelations link for the user.
 */
export async function postUserMoment(content: string, settings: AppSettings): Promise<void> {
  const now = Date.now()
  const momentId = uuid()
  await db.moments.add({ id: momentId, contactId: 'user', content, createdAt: now })

  if (!settings.apiKey || !promptModuleEnabled(settings, 'moments')) return
  const contacts = (await db.contacts.toArray()).filter((item) => !isAiTestId(item.id))
  if (contacts.length === 0) return

  const plans = planUserMomentReactors(contacts)
  if (plans.length === 0) return

  const commenterPlans = plans.filter((p) => p.willComment)
  let comments: string[] = []
  if (commenterPlans.length > 0) {
    try {
      const stickerNames = (await db.stickers.toArray()).map((s) => s.name)
      const contextRows = await Promise.all(commenterPlans.map(async ({ contact }) => {
        const [memories, social, events, originalContext] = await Promise.all([
          recentMemoriesText(contact.id, 4), socialMemoriesText(contact.id, 4), recentSocialEventsText([contact.id], 2, false),
          recentSharedOriginalContext([contact.id], settings.userNickname, { maxMessages: 45, maxChars: 6_500 }),
        ])
        return [contact.id, [originalContext, memories, social, events].filter(Boolean).join('\n\n').slice(0, 9_000)] as const
      }))
      const commentWorldbookPrompt =
        featureActive(settings, 'worldview')
          ? (getPromptTemplate(settings, 'worldview', 'momentsRuntime', {
              worldbookEntries: await retrieveWorldbookContext(content, { worldviewId: settings.activeWorldId || settings.defaultWorldviewId }),
            }) ?? '')
          : ''
      const raw = await chatCompletion({
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        model: settings.model,
        messages: [
          {
            role: 'system',
            content: buildUserMomentCommentPrompt(
              content,
              commenterPlans.map((p) => p.contact),
              commentWorldbookPrompt,
              stickerNames,
              new Map(contextRows),
              settings,
            ),
          },
          { role: 'user', content: '请生成' },
        ],
        jsonMode: true,
        purpose: 'moments',
      })
      const personaContext = [commentWorldbookPrompt, commenterPlans.map(({ contact }) => `${contact.name}: ${contact.systemPrompt}\nRelationship: ${contact.relationshipBase || 'friend'}`).join('\n\n')].filter(Boolean).join('\n\n')
      const reviewedRaw = await reviewMomentPayload(settings, raw, '{"comments":["..."]}', personaContext)
      comments = parseCommentsResponse(reviewedRaw, commenterPlans.length) ?? []
    } catch {
      // reactions are a nice-to-have; the moment itself already posted successfully
    }
  }

  let commentIndex = 0
  for (const plan of plans) {
    if (!await db.moments.get(momentId)) return
    await db.momentLikes.add({ id: uuid(), momentId, likerId: plan.contact.id, createdAt: now })
    await recordSocialEvent({
      type: 'moment_liked',
      actorId: plan.contact.id,
      targetId: 'user',
      relatedContactIds: [plan.contact.id],
      momentId,
      summary: `${plan.contact.name}赞了用户的朋友圈: ${content}`,
      importance: 1,
      createdAt: now,
    })
    if (plan.willComment) {
      const text = comments[commentIndex++]
      if (text) {
        await db.momentComments.add({
          id: uuid(),
          momentId,
          authorContactId: plan.contact.id,
          content: text,
          createdAt: now,
        })
        await recordSocialEvent({
          type: 'moment_commented',
          actorId: plan.contact.id,
          targetId: 'user',
          relatedContactIds: [plan.contact.id],
          momentId,
          summary: `${plan.contact.name}评论了用户的朋友圈: ${text}`,
          importance: 2,
          createdAt: now,
        })
      }
    }
  }
}

function cleanPlainReply(raw: string): string {
  let text = raw.trim()
  const fenceMatch = text.match(/```(?:\w+)?\s*([\s\S]*?)```/)
  if (fenceMatch) text = fenceMatch[1].trim()
  text = text.replace(/^["'“”'']+|["'“”'']+$/g, '').trim()
  return text
}

function buildMomentReplyPrompt(
  poster: Contact,
  momentContent: string,
  threadLines: string[],
  worldviewText: string,
  stickerNames: string[],
  context: string,
  settings: AppSettings,
): string {
  const worldviewSection = worldviewText ? `${worldviewText}\n\n` : ''
  const scheduleLine = describeCurrentSchedule(poster, new Date())
  const scheduleSection = scheduleLine ? `你${scheduleLine}(回复内容可以但不强制符合这个状态)\n` : ''

  const replyContext = `${worldviewSection}人设：${poster.systemPrompt}\n${scheduleSection}关系：${poster.relationshipBase || '朋友'} ${poster.relationshipDynamic || ''}；好感度=${poster.warmth ?? 0}；心情=${poster.mood?.text || '平静'}\n最近素材：${context || '无'}\n动态：${momentContent}\n评论串：\n${threadLines.join('\n')}\n${stickerCommentInstruction(stickerNames)}`
  const editable = getPromptTemplate(settings, 'moments', 'reply', { posterName: poster.name, replyContext }) ?? ''
  return `【身份硬约束】你现在只能是${poster.name}。只用${poster.name}的人设、经历和说话习惯回应；不得代入评论区其他人，不得替别人说话，也不得输出姓名或作者标记。\n${editable}\n\n【输出前硬检查】这句话只能由${poster.name}说出。固定输出协议：只输出一句纯文字回复，不要JSON、Markdown或引号。`
}

/**
 * Fires whenever the user leaves a comment (fresh or a reply to a specific
 * existing comment) on an AI's moment — the poster writes a reply directly
 * in the comment thread instead of the old behavior of queuing a
 * pendingEvents note that only surfaced the next time the user happened to
 * open a real 1:1 chat with them. Same "background, fire-and-forget,
 * best-effort" shape as postUserMoment's comment generation — MomentsPage
 * calls this without awaiting it, and dexie's useLiveQuery picks up the new
 * comment whenever it lands.
 */
export async function generateMomentReply(
  momentId: string,
  poster: Contact,
  triggeringCommentId: string,
  settings: AppSettings,
): Promise<void> {
  try {
    if (!settings.apiKey || !promptModuleEnabled(settings, 'moments')) return
    const moment = await db.moments.get(momentId)
    if (!moment) return

    const [allContacts, existingComments, stickers, privateMemories, socialMemories, events, originalContext] = await Promise.all([
      db.contacts.toArray().then((items) => items.filter((item) => !isAiTestId(item.id))),
      db.momentComments.where('momentId').equals(momentId).sortBy('createdAt'),
      db.stickers.toArray(),
      recentMemoriesText(poster.id, 4),
      socialMemoriesText(poster.id, 4),
      recentSocialEventsText([poster.id], 3, false),
      recentSharedOriginalContext([poster.id], settings.userNickname, { maxMessages: 60, maxChars: 8_000 }),
    ])
    const contactById = new Map(allContacts.map((c) => [c.id, c]))
    if (existingComments.some((comment) => comment.authorContactId === poster.id && comment.replyToCommentId === triggeringCommentId)) return
    const labelFor = (authorContactId: string) =>
      authorContactId === 'user' ? settings.userNickname || '我' : (contactById.get(authorContactId)?.name ?? '某人')
    const threadLines = existingComments.map((c) => `${labelFor(c.authorContactId)}: ${c.content}`)
    if (threadLines.length === 0) return // the triggering comment should always be in there; bail if something raced it away

    const stickerNames = stickers.map((s) => s.name)
    const replyWorldbookEntries =
      featureActive(settings, 'worldview')
        ? await retrieveWorldbookContext(`${poster.name}\n${poster.systemPrompt}\n${moment.content}\n${threadLines.join('\n')}`, { worldviewId: settings.activeWorldId || settings.defaultWorldviewId })
        : ''
    const replyWorldbookPrompt = replyWorldbookEntries
      ? (getPromptTemplate(settings, 'worldview', 'momentsRuntime', { worldbookEntries: replyWorldbookEntries }) ?? '')
      : ''
    const raw = await chatCompletion({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.model,
      messages: [
        {
          role: 'system',
          content: buildMomentReplyPrompt(
            poster,
            moment.content,
            threadLines,
            replyWorldbookPrompt,
            stickerNames,
            [originalContext, privateMemories, socialMemories, events].filter(Boolean).join('\n\n').slice(0, 9_500),
            settings,
          ),
        },
        { role: 'user', content: '请回复' },
      ],
      purpose: 'moments',
    })
    const cleaned = cleanPlainReply(raw)
    if (!cleaned) return
    if (!await db.moments.get(momentId)) return

    await db.momentComments.add({
      id: uuid(),
      momentId,
      authorContactId: poster.id,
      content: cleaned,
      createdAt: Date.now(),
      replyToCommentId: triggeringCommentId,
    })
    await recordSocialEvent({
      type: 'moment_commented',
      actorId: poster.id,
      targetId: 'user',
      relatedContactIds: [poster.id],
      momentId,
      summary: `${poster.name}在自己的朋友圈下回复了用户: ${cleaned}`,
      importance: 2,
    })
  } catch {
    // best-effort background reply; failing silently is fine, same as the other moments background jobs
  }
}

/**
 * One user interaction can open a small, bounded social thread. The model
 * receives only public moment material and a fixed candidate list; generated
 * comments never recursively call this function, so the thread cannot loop.
 */
export async function generateMomentDiscussion(
  momentId: string,
  posterContactId: string | undefined,
  triggeringCommentId: string,
  settings: AppSettings,
): Promise<void> {
  try {
    if (!settings.apiKey || !promptModuleEnabled(settings, 'moments')) return
    const [moment, contacts, comments] = await Promise.all([
      db.moments.get(momentId), db.contacts.toArray().then((items) => items.filter((item) => !isAiTestId(item.id))), db.momentComments.where('momentId').equals(momentId).sortBy('createdAt'),
    ])
    if (!moment) return
    const byId = new Map(contacts.map((contact) => [contact.id, contact]))
    const initiatingComment = comments.find((comment) => comment.id === triggeringCommentId)
    const addressedAuthorId = initiatingComment?.replyToCommentId
      ? comments.find((comment) => comment.id === initiatingComment.replyToCommentId)?.authorContactId
      : undefined
    const primaryId = addressedAuthorId && addressedAuthorId !== 'user' ? addressedAuthorId : moment.contactId
    const primary = byId.get(primaryId)
    const available = contacts.filter((contact) => isPhoneAvailable(contact, new Date()))
    // Identity is selected in code. The model receives only this responder's
    // persona, so a visible author can never accidentally speak as somebody else.
    const responder = primary && isPhoneAvailable(primary, new Date())
      ? primary
      : available[Math.floor(Math.random() * available.length)] || contacts[Math.floor(Math.random() * contacts.length)] || primary
    if (responder) {
      await generateMomentReply(momentId, responder, triggeringCommentId, settings)
      return
    }
    const trigger = comments.find((comment) => comment.id === triggeringCommentId)
    const directId = trigger?.replyToCommentId ? comments.find((comment) => comment.id === trigger.replyToCommentId)?.authorContactId : posterContactId
    const candidateIds = Array.from(new Set([
      directId,
      posterContactId,
      ...comments.slice(-8).map((comment) => comment.authorContactId),
    ].filter((id): id is string => !!id && id !== 'user' && byId.has(id)))).slice(0, 3)
    if (candidateIds.length === 0) return
    const candidates = candidateIds.map((id) => byId.get(id)!).filter((contact) => !!contact)
    const names = new Map(candidates.map((contact) => [contact.id, displayName(contact)]))
    const thread = comments.slice(-12).map((comment) => ({ id: comment.id, author: comment.authorContactId === 'user' ? settings.userNickname || '用户' : names.get(comment.authorContactId) || byId.get(comment.authorContactId)?.name || '某人', content: comment.content, replyTo: comment.replyToCommentId }))
    const discussionWorldbookPrompt =
      featureActive(settings, 'worldview')
        ? (getPromptTemplate(settings, 'worldview', 'momentsRuntime', {
            worldbookEntries: await retrieveWorldbookContext(`${moment.content}\n${JSON.stringify(thread)}`, { worldviewId: settings.activeWorldId || settings.defaultWorldviewId }),
          }) ?? '')
        : ''
    const discussionContext = `动态：${moment.content}
最新用户评论id：${commentIdMarker(triggeringCommentId)}
评论线程：${JSON.stringify(thread)}
候选角色：${JSON.stringify(candidates.map((contact) => ({ id: contact.id, name: displayName(contact), persona: contact.systemPrompt, mood: contact.mood?.text || '', relationToUser: contact.relationshipBase || '朋友' })))}
直接被回复者id：${directId && directId !== 'user' ? directId : 'none'}`
    const editable = getPromptTemplate(settings, 'moments', 'discussion', { worldbookPrompt: discussionWorldbookPrompt, discussionContext }) ?? ''
    const prompt = `${editable}\n\n固定输出协议：只输出JSON {"comments":[{"authorId":"candidate id","replyToCommentId":"optional existing comment id","content":"..."}]}`
    const raw = await chatCompletion({ apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.model, jsonMode: true, maxTokens: 500, purpose: 'moments', messages: [{ role: 'system', content: prompt }, { role: 'user', content: 'Generate the discussion.' }] })
    const parsed = JSON.parse(raw) as { comments?: Array<{ authorId?: unknown; replyToCommentId?: unknown; content?: unknown }> }
    const allowedReplyIds = new Set(comments.map((comment) => comment.id))
    const output = (parsed.comments ?? []).flatMap((item) => {
      const authorId = typeof item.authorId === 'string' ? item.authorId : ''
      const content = typeof item.content === 'string' ? item.content.trim().slice(0, 180) : ''
      const replyToCommentId = typeof item.replyToCommentId === 'string' && allowedReplyIds.has(item.replyToCommentId) ? item.replyToCommentId : triggeringCommentId
      return candidateIds.includes(authorId) && content ? [{ authorId, content, replyToCommentId }] : []
    }).slice(0, 3)
    if (directId && directId !== 'user' && candidateIds.includes(directId) && !output.some((item) => item.authorId === directId)) return
    for (const item of output) {
      if (!await db.moments.get(momentId)) return
      const id = uuid()
      await db.momentComments.add({ id, momentId, authorContactId: item.authorId, content: item.content, replyToCommentId: item.replyToCommentId, createdAt: Date.now() })
      await recordSocialEvent({ type: 'moment_commented', actorId: item.authorId, targetId: posterContactId, relatedContactIds: Array.from(new Set([item.authorId, ...(posterContactId ? [posterContactId] : [])])), momentId, messageId: id, summary: `${names.get(item.authorId) || '某人'}参与了朋友圈讨论: ${item.content}`, importance: 2 })
    }
  } catch {
    // A discussion is a best-effort enhancement; the user's own comment is already persisted.
  }
}

function commentIdMarker(id: string | undefined): string {
  return id || 'unknown'
}

/** Removes a moment and every piece of derived social data attached to it. */
export async function deleteMomentCompletely(momentId: string): Promise<boolean> {
  const moment = await db.moments.get(momentId)
  if (!moment) return false
  await db.transaction('rw', [db.moments, db.momentComments, db.momentLikes, db.socialEvents, db.contacts, db.mediaAssets], async () => {
    await db.momentComments.where('momentId').equals(momentId).delete()
    await db.momentLikes.where('momentId').equals(momentId).delete()
    const eventIds = await db.socialEvents.filter((event) => event.momentId === momentId).primaryKeys()
    if (eventIds.length > 0) await db.socialEvents.bulkDelete(eventIds as string[])
    await db.moments.delete(momentId)
    if (moment.imageAssetId) await db.mediaAssets.delete(moment.imageAssetId)
    if (moment.contactId !== 'user') {
      const remaining = await db.moments.where('contactId').equals(moment.contactId).toArray()
      const lastMomentAt = remaining.reduce((latest, item) => Math.max(latest, item.createdAt), 0)
      await db.contacts.update(moment.contactId, { lastMomentAt: lastMomentAt || undefined })
    }
  })
  // The album also collects images used by Moments. Preserve this image as a
  // standalone album item before its only remaining reference is removed.
  if (moment.imageUrl) {
    const settings = useSettingsStore.getState()
    const source = moment.imagePhotographer || /images\.pexels\.com/i.test(moment.imageUrl)
      ? 'Pexels 实拍图'
      : /waifu\.im/i.test(moment.imageUrl)
        ? '动漫图库'
        : '生图系统'
    const savedImages = settings.albumSavedImages ?? []
    if (!savedImages.some((image) => image.url === moment.imageUrl)) {
      settings.setSettings({
        albumSavedImages: [{
          url: moment.imageUrl,
          createdAt: moment.createdAt,
          source,
          caption: moment.content,
        }, ...savedImages],
      })
    }
  }
  return true
}

/**
 * Called when a contact is deleted: removes their own posted moments (and
 * every like/comment on those), their likes/comments on everyone else's
 * still-existing moments, and any relationship links involving them —
 * without touching other contacts' moments themselves.
 */
export async function cascadeDeleteContactSocialData(contactId: string): Promise<void> {
  const ownMoments = await db.moments.where('contactId').equals(contactId).toArray()
  for (const m of ownMoments) {
    await db.momentComments.where('momentId').equals(m.id).delete()
    await db.momentLikes.where('momentId').equals(m.id).delete()
    if (m.imageAssetId) await db.mediaAssets.delete(m.imageAssetId)
  }
  await db.moments.where('contactId').equals(contactId).delete()

  await db.momentComments.where('authorContactId').equals(contactId).delete()
  await db.momentLikes.where('likerId').equals(contactId).delete()

  await db.contactRelations.where('fromContactId').equals(contactId).delete()
  await db.contactRelations.where('toContactId').equals(contactId).delete()
  await db.contactMemories.where('contactId').equals(contactId).delete()
}
