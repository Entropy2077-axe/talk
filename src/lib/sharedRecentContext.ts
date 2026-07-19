import { db } from '../db/db'
import { displayName } from './contact'
import type { Message } from '../types'

const DEFAULT_LOOKBACK_MS = 36 * 60 * 60 * 1000

function messageContent(message: Message): string {
  if (message.type === 'text') return message.content.trim()
  if (message.type === 'sticker') return `[表情包：${message.content}]`
  if (message.type === 'image') return `[图片${message.image?.caption ? `：${message.image.caption}` : ''}]`
  return `[${message.type}：${message.content}]`
}

/** Verbatim cross-scene history for short-lived state that summaries can miss. */
export async function recentSharedOriginalContext(
  contactIds: string[],
  userNickname: string,
  options: { lookbackMs?: number; maxMessages?: number; maxMoments?: number; maxChars?: number; excludeConversationId?: string } = {},
): Promise<string> {
  const ids = new Set(contactIds)
  if (ids.size === 0) return ''
  const since = Date.now() - (options.lookbackMs ?? DEFAULT_LOOKBACK_MS)
  const maxMessages = options.maxMessages ?? 80
  const maxMoments = options.maxMoments ?? 18
  const maxChars = options.maxChars ?? 14_000
  const [contacts, groups, conversations, moments, momentComments] = await Promise.all([
    db.contacts.toArray(), db.groups.toArray(), db.conversations.toArray(),
    db.moments.where('createdAt').aboveOrEqual(since).sortBy('createdAt'),
    db.momentComments.filter((comment) => comment.createdAt >= since).toArray(),
  ])
  const contactsById = new Map(contacts.map((contact) => [contact.id, contact]))
  const groupsById = new Map(groups.map((group) => [group.id, group]))
  // All scenes share one factual timeline. Restricting this to groups the
  // current contact belongs to caused global user state (e.g. “I am going to
  // sleep”) to disappear merely because the next contact was not in that
  // group. Privacy is handled as a response rule, not by deleting continuity.
  const conversationIds = new Set(
    conversations
      .filter((conversation) => conversation.id !== options.excludeConversationId)
      .map((conversation) => conversation.id),
  )
  const conversationById = new Map(conversations.map((conversation) => [conversation.id, conversation]))
  const messages = (await db.messages.where('createdAt').aboveOrEqual(since).sortBy('createdAt'))
    .filter((message) => conversationIds.has(message.conversationId) && !message.pending)
    .slice(-maxMessages)
  const rows: Array<{ at: number; text: string }> = messages.map((message) => {
    const conversation = conversationById.get(message.conversationId)!
    const group = conversation.groupId ? groupsById.get(conversation.groupId) : undefined
    const privateContact = conversation.contactId ? contactsById.get(conversation.contactId) : undefined
    const assistant = message.speakerContactId ? contactsById.get(message.speakerContactId) : privateContact
    const speaker = message.role === 'user' ? (userNickname || '用户') : assistant ? displayName(assistant) : '群成员'
    const scene = group ? `群聊「${group.name}」` : `私聊「${privateContact ? displayName(privateContact) : '未知联系人'}」`
    return { at: message.createdAt, text: `${new Date(message.createdAt).toLocaleString()}｜${scene}｜${speaker}：${messageContent(message)}` }
  })
  for (const moment of moments.slice(-maxMoments)) {
    const author = moment.contactId === 'user' ? (userNickname || '用户') : contactsById.get(moment.contactId)?.name
    if (author) rows.push({ at: moment.createdAt, text: `${new Date(moment.createdAt).toLocaleString()}｜朋友圈｜${author}：${moment.content}` })
  }
  const momentById = new Map(moments.map((moment) => [moment.id, moment]))
  for (const comment of momentComments.sort((a, b) => a.createdAt - b.createdAt).slice(-maxMoments * 2)) {
    const moment = momentById.get(comment.momentId)
    if (!moment) continue
    const author = comment.authorContactId === 'user' ? (userNickname || '用户') : contactsById.get(comment.authorContactId)?.name
    const poster = moment.contactId === 'user' ? (userNickname || '用户') : contactsById.get(moment.contactId)?.name
    if (author && poster) rows.push({ at: comment.createdAt, text: `${new Date(comment.createdAt).toLocaleString()}｜朋友圈评论｜${author}在${poster}的动态下：${comment.content}` })
  }
  const ordered = rows.sort((a, b) => a.at - b.at).map((row) => row.text)
  const kept: string[] = []
  let chars = 0
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (chars + ordered[i].length + 1 > maxChars && kept.length > 0) break
    kept.push(ordered[i])
    chars += ordered[i].length + 1
  }
  if (kept.length === 0) return ''
  return `【近期跨场景原文时间线】\n以下是近期真实记录，越靠后越新。用它维持睡觉、出门、情绪和话题等短期状态；后面的明确状态会覆盖前面的状态。状态会随现实时间自然失效，例如昨晚说“睡了”不代表第二天仍在睡。不得把未发生的事补成事实。其他私聊中的内容只用于维持世界状态，角色不能表现得像亲耳听过，也不得在群聊或朋友圈公开泄露。\n【状态承接规则】用户已经明确说出新状态时，把它当作已确认事实并直接承接当前消息；不要为了展示记忆而把它重复成“你不睡了？”“你起来了？”“你要喝咖啡？”之类的确认问句。最新消息是邀请、问题或请求时，先直接回应它。只有记录彼此真正矛盾、用户措辞不确定，或缺少完成当前回应所必需的信息时才追问。\n${kept.reverse().join('\n')}`
}
