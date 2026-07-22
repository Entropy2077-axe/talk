import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { chatCompletion } from './deepseek'
import { momentReactionProbability, uniqueRelationPairs } from './contactRelations'
import { describeCurrentSchedule, isPhoneAvailable } from './schedule'
import { searchPexelsPhoto } from './photoSearch'
import { recordSocialEvent } from './socialEvents'
import { displayName } from './contact'
import { customPersonalityTraitsLine, formatSpeechSamplesForScene, personalityTraitLine } from './prompt'
import { isModuleEnabled } from '../features'
import { retrieveWorldbookContext } from './worldbook'
import { recentMemoriesText, socialMemoriesText } from './memory'
import { recentSocialEventsText } from './socialEvents'
import { recentSharedOriginalContext } from './sharedRecentContext'
import { parseTurnLogicReview } from './turnLogicReviewer'
import type { AppSettings, Contact } from '../types'
import { getPromptTemplate, promptModuleEnabled } from './promptModules'

const ELIGIBLE_WINDOW_MS = 10 * 60 * 1000
/** Of the friends who *do* react (relationship allows it and the dice roll passed), this fraction also leave a comment instead of just liking. */
const COMMENT_SHARE = 0.55
/** Even a friend/good relationship has a chance of just scrolling past without reacting at all. */
/** Not every moment gets a photo — matches real WeChat moments where plenty of posts are text-only. Decided in code before the model even writes the content, same "code decides, model fills in" split as everywhere else. */
const MOMENT_PHOTO_PROBABILITY = 0.6

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
    (c) => (!c.lastMomentAt || now - c.lastMomentAt > ELIGIBLE_WINDOW_MS) && isPhoneAvailable(c, nowDate),
  )
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
                  `  评论者${j + 1}: ${c.contact.name}\n  人设: ${c.contact.systemPrompt}\n  ${personalityTraitLine(c.contact.personalityTrait, c.contact.warmth ?? 0) || '性格特质: 无'}\n  说话样例: ${formatSpeechSamplesForScene(c.contact.speechSamples, 'moment', 1) || '无'}\n  与发布者的关系: ${c.relationLabel || '普通朋友'}；${c.relationContext}\n  与用户的共同过往（只作关系底色，不公开复述）: ${c.contact.sharedHistory || '无具体记录'}\n  最近可用素材: ${contexts.get(c.contact.id) || '无'}`,
              )
              .join('\n')
          : '  （这条没有人评论）'
      const scheduleLine = describeCurrentSchedule(e.poster, now)
      const statusLine = scheduleLine ? `${e.poster.name}${scheduleLine} (内容可以但不强制符合这个状态)\n` : ''
      const photoLine = e.willHavePhoto
        ? `这条动态会配一张照片 你还需要为它写一个"imageKeyword"(简短英文搜图短语 贴合你写的这条朋友圈内容 用来找一张对应的照片)\n`
        : ''
      return `人物${i + 1}: ${e.poster.name}\n人设: ${e.poster.systemPrompt}\n${personalityTraitLine(e.poster.personalityTrait, e.poster.warmth ?? 0) || '性格特质: 无'}\n说话样例: ${formatSpeechSamplesForScene(e.poster.speechSamples, 'moment', 2) || '无'}\n与用户的共同过往（只作关系底色，不公开复述）: ${e.poster.sharedHistory || '无具体记录'}\n当前心情: ${e.poster.mood?.text || '平静'}\n最近可用素材: ${contexts.get(e.poster.id) || '无'}\n${statusLine}${photoLine}这条朋友圈下会评论的人(按顺序):\n${commenterLines}`
    })
    .join('\n\n')

  const worldviewSection = worldviewText ? `${worldviewText}\n\n` : ''

  const editable = getPromptTemplate(settings, 'moments', 'generation', { momentContext: `${worldviewSection}${stickerCommentInstruction(stickerNames)}\n${sections}` }) ?? ''
  return `${editable}\n\n固定输出协议：只输出JSON {"moments":[{"content":"人物1动态","imageKeyword":"需要配图才填写","comments":["评论者1评论"]}]}。moments及comments必须与输入顺序和数量一致。`
}

interface ParsedMoment {
  content: string
  comments: string[]
  imageKeyword: string
}

function parseMomentsResponse(raw: string, expected: number[]): ParsedMoment[] | null {
  let text = raw.trim()
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch) text = fenceMatch[1].trim()
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed?.moments) || parsed.moments.length !== expected.length) return null
    const result: ParsedMoment[] = []
    for (let i = 0; i < parsed.moments.length; i++) {
      const m = parsed.moments[i]
      if (!m || typeof m.content !== 'string' || !m.content.trim()) return null
      const comments: string[] = Array.isArray(m.comments)
        ? m.comments.filter((c: unknown): c is string => typeof c === 'string' && c.trim().length > 0)
        : []
      const imageKeyword = typeof m.imageKeyword === 'string' ? m.imageKeyword.trim() : ''
      result.push({ content: m.content.trim(), comments, imageKeyword })
    }
    return result
  } catch {
    return null
  }
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
    if (verdict.valid) return raw

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

/**
 * The whole "who posts, who reacts" decision lives in code (per the user's
 * explicit request for a random system, not left to the model's whim) — the
 * single API call this makes is purely for writing the moment text and
 * comment text for whichever posters/reactors were already chosen.
 */
export async function refreshMoments(settings: AppSettings): Promise<RefreshMomentsResult> {
  if (!promptModuleEnabled(settings, 'moments')) return { postedCount: 0, message: '朋友圈提示词模块已屏蔽' }
  const startedAt = performance.now()
  const contacts = await db.contacts.toArray()
  if (contacts.length === 0) return { postedCount: 0, message: '还没有联系人' }
  if (!settings.apiKey) return { postedCount: 0, message: '还没有配置API Key' }

  const now = Date.now()
  const eligible = eligiblePosters(contacts, now)
  if (eligible.length === 0) return { postedCount: 0, message: '大家都刚发过 稍后再刷新试试' }

  const count = pickPosterCount(eligible.length, contacts.length, settings.proactiveMomentsMax)
  const posters = shuffle(eligible).slice(0, count)
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
  const momentsWorldbookPrompt =
    isModuleEnabled('worldview') && promptModuleEnabled(settings, 'worldview')
      ? (getPromptTemplate(settings, 'worldview', 'momentsRuntime', {
          worldbookEntries: await retrieveWorldbookContext(entries.map((e) => `${e.poster.name} ${e.poster.systemPrompt} ${e.poster.memoryFacts}`).join('\n')),
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
  const personaContext = [momentsWorldbookPrompt, entries.map((entry) => `Poster ${entry.poster.name}: ${entry.poster.systemPrompt}\nTrait: ${entry.poster.personalityTrait || 'none'}\nShared history anchor (do not expose verbatim): ${entry.poster.sharedHistory || 'none'}\nCommenters: ${entry.commenters.filter((commenter) => commenter.willComment).map((commenter) => `${commenter.contact.name}: ${commenter.contact.systemPrompt}; history=${commenter.contact.sharedHistory || 'none'}`).join(' | ') || 'none'}`).join('\n\n')].filter(Boolean).join('\n\n')
  const reviewedRaw = await reviewMomentPayload(settings, raw, '{"moments":[{"content":"...","imageKeyword":"...","comments":["..."]}]}', personaContext)
  console.info(`[moments-perf] 自检完成=${Math.round(performance.now() - startedAt)}ms 条数=${entries.length}`)
  const parsed = parseMomentsResponse(reviewedRaw, expectedCommentCounts)
  if (!parsed) return { postedCount: 0, message: '生成失败 请再刷新试试' }

  for (let i = 0; i < entries.length; i++) {
    const { poster, commenters, willHavePhoto } = entries[i]
    const { content, comments, imageKeyword } = parsed[i]
    const momentId = uuid()

    let imageUrl: string | undefined
    let imagePhotographer: string | undefined
    let imagePhotographerUrl: string | undefined
    if (willHavePhoto && imageKeyword && settings.pexelsApiKey) {
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

    await db.moments.add({
      id: momentId,
      contactId: poster.id,
      content,
      createdAt: now + i,
      imageUrl,
      imagePhotographer,
      imagePhotographerUrl,
    })
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

  return { postedCount: entries.length }
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
      const samples = formatSpeechSamplesForScene(c.speechSamples, 'moment', 1)
      return `评论者${i + 1}: ${c.name} 人设: ${c.systemPrompt}\n${personalityTraitLine(c.personalityTrait, c.warmth ?? 0) || '性格特质: 无'}${samples ? `\n说话样例: ${samples}` : ''}${scheduleLine ? ` ${scheduleLine}` : ''}\n和用户的关系: ${c.relationshipBase || '朋友'} ${c.relationshipDynamic || ''} 好感度:${c.warmth ?? 0} 当前心情:${c.mood?.text || '平静'}\n与用户的共同过往（只作关系底色，不公开复述）: ${c.sharedHistory || '无具体记录'}\n最近素材: ${contexts.get(c.id) || '无'}`
    })
    .join('\n')
  const worldviewSection = worldviewText ? `${worldviewText}\n\n` : ''
  const commentContext = `${worldviewSection}用户动态：${content}\n评论者：\n${commenterLines}\n${stickerCommentInstruction(stickerNames)}`
  const editable = getPromptTemplate(settings, 'moments', 'comments', { commentContext }) ?? ''
  return `${editable}\n\n固定输出协议：只输出JSON {"comments":["评论者1的评论","评论者2的评论"]}，数组顺序和数量必须与评论者一致。`
}

function parseCommentsResponse(raw: string, expectedCount: number): string[] | null {
  let text = raw.trim()
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch) text = fenceMatch[1].trim()
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed?.comments) || parsed.comments.length !== expectedCount) return null
    return parsed.comments.map((c: unknown) => (typeof c === 'string' ? c.trim() : ''))
  } catch {
    return null
  }
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
  const contacts = await db.contacts.toArray()
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
        isModuleEnabled('worldview') && promptModuleEnabled(settings, 'worldview')
          ? (getPromptTemplate(settings, 'worldview', 'momentsRuntime', {
              worldbookEntries: await retrieveWorldbookContext(content),
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
      const personaContext = [commentWorldbookPrompt, commenterPlans.map(({ contact }) => `${contact.name}: ${contact.systemPrompt}\nTrait: ${contact.personalityTrait || 'none'}\nRelationship: ${contact.relationshipBase || 'friend'}\nShared history anchor (do not expose verbatim): ${contact.sharedHistory || 'none'}`).join('\n\n')].filter(Boolean).join('\n\n')
      const reviewedRaw = await reviewMomentPayload(settings, raw, '{"comments":["..."]}', personaContext)
      comments = parseCommentsResponse(reviewedRaw, commenterPlans.length) ?? []
    } catch {
      // reactions are a nice-to-have; the moment itself already posted successfully
    }
  }

  let commentIndex = 0
  for (const plan of plans) {
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

  const samples = formatSpeechSamplesForScene(poster.speechSamples, 'moment', 2)
  const replyContext = `${worldviewSection}人设：${poster.systemPrompt}\n${personalityTraitLine(poster.personalityTrait, poster.warmth ?? 0) || '性格特质: 无'}${customPersonalityTraitsLine(poster.customPersonalityTraits, poster.warmth ?? 0)}${samples ? `\n说话样例：\n${samples}` : ''}\n${scheduleSection}关系：${poster.relationshipBase || '朋友'} ${poster.relationshipDynamic || ''}；好感度=${poster.warmth ?? 0}；心情=${poster.mood?.text || '平静'}\n共同过往：${poster.sharedHistory || '无具体记录'}\n最近素材：${context || '无'}\n动态：${momentContent}\n评论串：\n${threadLines.join('\n')}\n${stickerCommentInstruction(stickerNames)}`
  const editable = getPromptTemplate(settings, 'moments', 'reply', { posterName: poster.name, replyContext }) ?? ''
  return `${editable}\n\n固定输出协议：只输出一句纯文字回复，不要JSON、Markdown或引号。`
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
      db.contacts.toArray(),
      db.momentComments.where('momentId').equals(momentId).sortBy('createdAt'),
      db.stickers.toArray(),
      recentMemoriesText(poster.id, 4),
      socialMemoriesText(poster.id, 4),
      recentSocialEventsText([poster.id], 3, false),
      recentSharedOriginalContext([poster.id], settings.userNickname, { maxMessages: 60, maxChars: 8_000 }),
    ])
    const contactById = new Map(allContacts.map((c) => [c.id, c]))
    const labelFor = (authorContactId: string) =>
      authorContactId === 'user' ? settings.userNickname || '我' : (contactById.get(authorContactId)?.name ?? '某人')
    const threadLines = existingComments.map((c) => `${labelFor(c.authorContactId)}: ${c.content}`)
    if (threadLines.length === 0) return // the triggering comment should always be in there; bail if something raced it away

    const stickerNames = stickers.map((s) => s.name)
    const replyWorldbookEntries =
      isModuleEnabled('worldview') && promptModuleEnabled(settings, 'worldview')
        ? await retrieveWorldbookContext(`${poster.name}\n${poster.systemPrompt}\n${moment.content}\n${threadLines}`)
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
      db.moments.get(momentId), db.contacts.toArray(), db.momentComments.where('momentId').equals(momentId).sortBy('createdAt'),
    ])
    if (!moment) return
    const byId = new Map(contacts.map((contact) => [contact.id, contact]))
    const trigger = comments.find((comment) => comment.id === triggeringCommentId)
    const directId = trigger?.replyToCommentId ? comments.find((comment) => comment.id === trigger.replyToCommentId)?.authorContactId : posterContactId
    const candidateIds = Array.from(new Set([
      directId,
      posterContactId,
      ...comments.slice(-8).map((comment) => comment.authorContactId),
    ].filter((id): id is string => !!id && id !== 'user' && byId.has(id)))).slice(0, 3)
    if (candidateIds.length === 0) return
    const candidates = candidateIds.map((id) => byId.get(id)!).filter(Boolean)
    const names = new Map(candidates.map((contact) => [contact.id, displayName(contact)]))
    const thread = comments.slice(-12).map((comment) => ({ id: comment.id, author: comment.authorContactId === 'user' ? settings.userNickname || '用户' : names.get(comment.authorContactId) || byId.get(comment.authorContactId)?.name || '某人', content: comment.content, replyTo: comment.replyToCommentId }))
    const discussionWorldbookPrompt =
      isModuleEnabled('worldview') && promptModuleEnabled(settings, 'worldview')
        ? (getPromptTemplate(settings, 'worldview', 'momentsRuntime', {
            worldbookEntries: await retrieveWorldbookContext(`${moment.content}\n${JSON.stringify(thread)}`),
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
  }
  await db.moments.where('contactId').equals(contactId).delete()

  await db.momentComments.where('authorContactId').equals(contactId).delete()
  await db.momentLikes.where('likerId').equals(contactId).delete()

  await db.contactRelations.where('fromContactId').equals(contactId).delete()
  await db.contactRelations.where('toContactId').equals(contactId).delete()
}
