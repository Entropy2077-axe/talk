import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { chatCompletion } from './deepseek'
import { canReactToMoments } from './contactRelations'
import { describeCurrentSchedule, isPhoneAvailable } from './schedule'
import { searchPexelsPhoto } from './photoSearch'
import type { AppSettings, Contact } from '../types'

const ELIGIBLE_WINDOW_MS = 10 * 60 * 1000
/** Of the friends who *do* react (relationship allows it and the dice roll passed), this fraction also leave a comment instead of just liking. */
const COMMENT_SHARE = 0.55
/** Even a friend/good relationship has a chance of just scrolling past without reacting at all. */
const REACT_PROBABILITY = 0.6
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
export function pickPosterCount(eligibleCount: number, totalContacts: number): number {
  if (eligibleCount <= 0) return 0
  const upperExclusive = eligibleCount > 5 ? 5 : totalContacts
  const count = upperExclusive > 2 ? 2 + Math.floor(Math.random() * (upperExclusive - 2)) : 1
  return Math.max(1, Math.min(count, eligibleCount))
}

interface ReactorPlan {
  contact: Contact
  willComment: boolean
}

/** For one posting contact, decides (via the relationship graph + dice rolls, not the LLM) which of their linked friends react, and whether each reaction includes a comment. */
async function planReactors(poster: Contact, contactsById: Map<string, Contact>): Promise<ReactorPlan[]> {
  const links = await db.contactRelations
    .where('fromContactId')
    .equals(poster.id)
    .or('toContactId')
    .equals(poster.id)
    .toArray()

  const candidates: Contact[] = []
  for (const link of links) {
    if (!canReactToMoments(link.label)) continue
    const otherId = link.fromContactId === poster.id ? link.toContactId : link.fromContactId
    const other = contactsById.get(otherId)
    if (other) candidates.push(other)
  }

  const plans: ReactorPlan[] = []
  for (const candidate of candidates) {
    if (Math.random() > REACT_PROBABILITY) continue // relationship was fine, still scrolled past
    plans.push({ contact: candidate, willComment: Math.random() < COMMENT_SHARE })
  }
  return plans
}

function buildMomentsPrompt(
  entries: { poster: Contact; commenters: ReactorPlan[]; willHavePhoto: boolean }[],
  worldviewText: string,
  stickerNames: string[],
): string {
  const now = new Date()
  const sections = entries
    .map((e, i) => {
      const commenterLines =
        e.commenters.length > 0
          ? e.commenters
              .filter((c) => c.willComment)
              .map((c, j) => `  评论者${j + 1}: ${c.contact.name} 人设: ${c.contact.systemPrompt}`)
              .join('\n')
          : '  （这条没有人评论）'
      const scheduleLine = describeCurrentSchedule(e.poster, now)
      const statusLine = scheduleLine ? `${e.poster.name}${scheduleLine} (内容可以但不强制符合这个状态)\n` : ''
      const photoLine = e.willHavePhoto
        ? `这条动态会配一张照片 你还需要为它写一个"imageKeyword"(简短英文搜图短语 贴合你写的这条朋友圈内容 用来找一张对应的照片)\n`
        : ''
      return `人物${i + 1}: ${e.poster.name}\n人设: ${e.poster.systemPrompt}\n${statusLine}${photoLine}这条朋友圈下会评论的人(按顺序):\n${commenterLines}`
    })
    .join('\n\n')

  const worldviewSection = worldviewText ? `【这个世界的设定 所有人的朋友圈内容都要符合这个设定】\n${worldviewText}\n\n` : ''

  return `${worldviewSection}你是一个朋友圈内容生成器 只输出JSON 不要有任何其他文字

下面有几个人分别要发一条朋友圈动态 请你分别为每个人写一条符合他们性格的纯文字朋友圈内容(30到80字 口语化随性 不要用括号描述动作神态)。**朋友圈是发给所有人看的公开动态 不是私聊 绝对不能写成"我跟你说""告诉你""咱们"这种对着某个特定的人说话的语气** 就当是发一条谁都能看到的广播 可以用"大家""谁"这类泛指 也可以什么都不带纯粹自言自语 然后为每条动态下面标注的评论者也各自写一条符合他们性格、符合他们和发布者关系的评论(简短口语化 不用括号 评论本身是回复给发布者看的 可以正常用"你")
${stickerCommentInstruction(stickerNames)}
${sections}

输出格式:
{
  "moments": [
    { "content": "人物1的朋友圈文字", "imageKeyword": "只有被要求配图的人物才填 不需要配图就留空字符串", "comments": ["评论者1写的评论", "评论者2写的评论"] },
    { "content": "人物2的朋友圈文字", "imageKeyword": "", "comments": [] }
  ]
}

要求:
- moments数组顺序必须和上面"人物1/人物2..."的顺序完全一致 一个不能少
- 每条comments数组的元素数量必须和该人物下面列出的评论者数量完全一致、顺序一致 没有评论者就是空数组
- imageKeyword只有明确标注"这条动态会配一张照片"的人物才需要填写 其余人物这个字段留空字符串
- 只输出JSON 不要markdown代码块标记`
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
  const contacts = await db.contacts.toArray()
  if (contacts.length === 0) return { postedCount: 0, message: '还没有联系人' }
  if (!settings.apiKey) return { postedCount: 0, message: '还没有配置API Key' }

  const now = Date.now()
  const eligible = eligiblePosters(contacts, now)
  if (eligible.length === 0) return { postedCount: 0, message: '大家都刚发过 稍后再刷新试试' }

  const count = pickPosterCount(eligible.length, contacts.length)
  const posters = shuffle(eligible).slice(0, count)
  const contactsById = new Map(contacts.map((c) => [c.id, c]))

  const entries: { poster: Contact; commenters: ReactorPlan[]; willHavePhoto: boolean }[] = []
  for (const poster of posters) {
    const commenters = await planReactors(poster, contactsById)
    entries.push({ poster, commenters, willHavePhoto: Math.random() < MOMENT_PHOTO_PROBABILITY })
  }

  const stickerNames = (await db.stickers.toArray()).map((s) => s.name)
  const raw = await chatCompletion({
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    model: settings.model,
    messages: [
      { role: 'system', content: buildMomentsPrompt(entries, settings.worldview, stickerNames) },
      { role: 'user', content: '请生成' },
    ],
    jsonMode: true,
  })

  const expectedCommentCounts = entries.map((e) => e.commenters.filter((c) => c.willComment).length)
  const parsed = parseMomentsResponse(raw, expectedCommentCounts)
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
    await db.contacts.update(poster.id, { lastMomentAt: now })

    let commentIndex = 0
    for (const reactor of commenters) {
      // everyone in the reactor plan reacts with at least a like
      await db.momentLikes.add({ id: uuid(), momentId, likerId: reactor.contact.id, createdAt: now })
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

function buildUserMomentCommentPrompt(content: string, commenters: Contact[], worldviewText: string, stickerNames: string[]): string {
  const now = new Date()
  const commenterLines = commenters
    .map((c, i) => {
      const scheduleLine = describeCurrentSchedule(c, now)
      return `评论者${i + 1}: ${c.name} 人设: ${c.systemPrompt}${scheduleLine ? ` ${scheduleLine}` : ''}`
    })
    .join('\n')
  const worldviewSection = worldviewText ? `【这个世界的设定】\n${worldviewText}\n\n` : ''
  return `${worldviewSection}你是一个朋友圈评论生成器 只输出JSON 不要有任何其他文字

用户发了一条朋友圈: "${content}"

下面几个人会在这条朋友圈下评论 请分别以他们的人设和口语化语气各写一句评论(简短随性 不用括号描述动作神态):
${commenterLines}
${stickerCommentInstruction(stickerNames)}

输出格式:
{"comments": ["评论者1的评论", "评论者2的评论"]}

要求:
- comments数组顺序必须和上面评论者顺序完全一致 数量必须完全一致
- 只输出JSON 不要markdown代码块标记`
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

  if (!settings.apiKey) return
  const contacts = await db.contacts.toArray()
  if (contacts.length === 0) return

  const plans = planUserMomentReactors(contacts)
  if (plans.length === 0) return

  const commenterPlans = plans.filter((p) => p.willComment)
  let comments: string[] = []
  if (commenterPlans.length > 0) {
    try {
      const stickerNames = (await db.stickers.toArray()).map((s) => s.name)
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
              settings.worldview,
              stickerNames,
            ),
          },
          { role: 'user', content: '请生成' },
        ],
        jsonMode: true,
      })
      comments = parseCommentsResponse(raw, commenterPlans.length) ?? []
    } catch {
      // reactions are a nice-to-have; the moment itself already posted successfully
    }
  }

  let commentIndex = 0
  for (const plan of plans) {
    await db.momentLikes.add({ id: uuid(), momentId, likerId: plan.contact.id, createdAt: now })
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
): string {
  const worldviewSection = worldviewText ? `【这个世界的设定】\n${worldviewText}\n\n` : ''
  const scheduleLine = describeCurrentSchedule(poster, new Date())
  const scheduleSection = scheduleLine ? `你${scheduleLine}(回复内容可以但不强制符合这个状态)\n` : ''

  return `${worldviewSection}你是${poster.name} 人设: ${poster.systemPrompt}
${scheduleSection}
你发的这条朋友圈: "${momentContent}"

这条朋友圈下面的评论串(按时间顺序):
${threadLines.join('\n')}
${stickerCommentInstruction(stickerNames)}
请你以自己的人设和口语化语气 针对评论串里**最后一条**评论 直接在评论区写一句回复 简短随性 一句话就行 不用括号描述动作神态 不要重复自我介绍 不要加"回复xxx:"这种前缀
只输出这句回复的纯文字 不要输出JSON、markdown代码块或者引号`
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
    if (!settings.apiKey) return
    const moment = await db.moments.get(momentId)
    if (!moment) return

    const [allContacts, existingComments, stickers] = await Promise.all([
      db.contacts.toArray(),
      db.momentComments.where('momentId').equals(momentId).sortBy('createdAt'),
      db.stickers.toArray(),
    ])
    const contactById = new Map(allContacts.map((c) => [c.id, c]))
    const labelFor = (authorContactId: string) =>
      authorContactId === 'user' ? settings.userNickname || '我' : (contactById.get(authorContactId)?.name ?? '某人')
    const threadLines = existingComments.map((c) => `${labelFor(c.authorContactId)}: ${c.content}`)
    if (threadLines.length === 0) return // the triggering comment should always be in there; bail if something raced it away

    const stickerNames = stickers.map((s) => s.name)
    const raw = await chatCompletion({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.model,
      messages: [
        {
          role: 'system',
          content: buildMomentReplyPrompt(poster, moment.content, threadLines, settings.worldview, stickerNames),
        },
        { role: 'user', content: '请回复' },
      ],
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
  } catch {
    // best-effort background reply; failing silently is fine, same as the other moments background jobs
  }
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
