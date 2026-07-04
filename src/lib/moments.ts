import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { chatCompletion } from './deepseek'
import { canReactToMoments } from './contactRelations'
import type { AppSettings, Contact } from '../types'

const ELIGIBLE_WINDOW_MS = 10 * 60 * 1000
/** Of the friends who *do* react (relationship allows it and the dice roll passed), this fraction also leave a comment instead of just liking. */
const COMMENT_SHARE = 0.55
/** Even a friend/good relationship has a chance of just scrolling past without reacting at all. */
const REACT_PROBABILITY = 0.6

function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

export function eligiblePosters(contacts: Contact[], now: number): Contact[] {
  return contacts.filter((c) => !c.lastMomentAt || now - c.lastMomentAt > ELIGIBLE_WINDOW_MS)
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

function buildMomentsPrompt(entries: { poster: Contact; commenters: ReactorPlan[] }[]): string {
  const sections = entries
    .map((e, i) => {
      const commenterLines =
        e.commenters.length > 0
          ? e.commenters
              .filter((c) => c.willComment)
              .map((c, j) => `  评论者${j + 1}: ${c.contact.name} 人设: ${c.contact.systemPrompt}`)
              .join('\n')
          : '  （这条没有人评论）'
      return `人物${i + 1}: ${e.poster.name}\n人设: ${e.poster.systemPrompt}\n这条朋友圈下会评论的人(按顺序):\n${commenterLines}`
    })
    .join('\n\n')

  return `你是一个朋友圈内容生成器 只输出JSON 不要有任何其他文字

下面有几个人分别要发一条朋友圈动态 请你分别为每个人写一条符合他们性格的纯文字朋友圈内容(30到80字 口语化随性 不要用括号描述动作神态) 然后为每条动态下面标注的评论者也各自写一条符合他们性格、符合他们和发布者关系的评论(简短口语化 不用括号)

${sections}

输出格式:
{
  "moments": [
    { "content": "人物1的朋友圈文字", "comments": ["评论者1写的评论", "评论者2写的评论"] },
    { "content": "人物2的朋友圈文字", "comments": [] }
  ]
}

要求:
- moments数组顺序必须和上面"人物1/人物2..."的顺序完全一致 一个不能少
- 每条comments数组的元素数量必须和该人物下面列出的评论者数量完全一致、顺序一致 没有评论者就是空数组
- 只输出JSON 不要markdown代码块标记`
}

interface ParsedMoment {
  content: string
  comments: string[]
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
      result.push({ content: m.content.trim(), comments })
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

  const entries: { poster: Contact; commenters: ReactorPlan[] }[] = []
  for (const poster of posters) {
    const commenters = await planReactors(poster, contactsById)
    entries.push({ poster, commenters })
  }

  const raw = await chatCompletion({
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    model: settings.model,
    messages: [
      { role: 'system', content: buildMomentsPrompt(entries) },
      { role: 'user', content: '请生成' },
    ],
    jsonMode: true,
  })

  const expectedCommentCounts = entries.map((e) => e.commenters.filter((c) => c.willComment).length)
  const parsed = parseMomentsResponse(raw, expectedCommentCounts)
  if (!parsed) return { postedCount: 0, message: '生成失败 请再刷新试试' }

  for (let i = 0; i < entries.length; i++) {
    const { poster, commenters } = entries[i]
    const { content, comments } = parsed[i]
    const momentId = uuid()
    await db.moments.add({ id: momentId, contactId: poster.id, content, createdAt: now + i })
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
