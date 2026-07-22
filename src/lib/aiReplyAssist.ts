import { db } from '../db/db'
import { isModuleEnabled } from '../features'
import type { AppSettings, Contact, Group, Message } from '../types'
import { chatCompletion } from './deepseek'
import { describeCurrentSchedule, describeUpcomingScheduleText } from './schedule'
import { recentSocialEventsText } from './socialEvents'
import { retrieveWorldbookContext } from './worldbook'
import { getPromptTemplate, promptModuleEnabled } from './promptModules'

function trimText(value: unknown, limit = 900) {
  const text = String(value || '').trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function userProfileText(settings: AppSettings) {
  const parts = [
    settings.userNickname && `昵称：${settings.userNickname}`,
    settings.userGender && `性别：${settings.userGender}`,
    settings.userBirthday && `生日：${settings.userBirthday}`,
    settings.userOccupation && `职业：${settings.userOccupation}`,
    settings.userBio && `个人简介：${settings.userBio}`,
  ].filter(Boolean)
  return parts.length ? parts.join('\n') : '用户尚未填写个人资料；不要擅自补充。'
}

function cleanDraft(raw: string) {
  return raw
    .trim()
    .replace(/^```(?:text|markdown)?\s*/i, '')
    .replace(/\s*```$/, '')
    .replace(/^(?:回复(?:内容)?|代写(?:内容)?|草稿)\s*[:：]\s*/i, '')
    .replace(/^['“”"]|['“”"]$/g, '')
    .trim()
}

export async function draftReply(
  settings: AppSettings,
  messages: Message[],
  contact?: Contact,
  group?: Group,
) {
  const history = messages
    .slice(-14)
    .map((message) => `${message.role === 'user' ? settings.userNickname || '用户' : contact?.name || '群成员'}：${message.content}`)
    .join('\n')
  const members = group ? (await db.contacts.bulkGet(group.memberContactIds)).filter(Boolean) as Contact[] : []
  const socialContext = contact
    ? await recentSocialEventsText([contact.id], 6)
    : group
      ? await recentSocialEventsText(group.memberContactIds.slice(0, 6), 6)
      : ''
  const baseContext = [history, userProfileText(settings), contact?.systemPrompt, contact?.memoryFacts, group?.memory, group?.vibe]
    .filter(Boolean)
    .join('\n')
  const worldbookContext = isModuleEnabled('worldview') && promptModuleEnabled(settings, 'worldview')
    ? await retrieveWorldbookContext(baseContext, { maxEntries: 4, maxChars: 2400 })
    : ''

  const privateContext = contact
    ? [
        `聊天对象：${contact.name}`,
        `角色设定：${trimText(contact.systemPrompt, 1400) || '无'}`,
        `关系：${contact.relationshipBase || '普通'}；当前关系状态：${contact.relationshipDynamic || '无'}`,
        `角色记忆：${trimText(contact.memoryFacts, 1000) || '无'}`,
        `当前心情：${contact.mood?.text || '未知'}`,
        `对方当前日程：${describeCurrentSchedule(contact, new Date()) || '无'}`,
        `对方近期日程：${describeUpcomingScheduleText(contact, new Date()) || '无'}`,
      ].join('\n')
    : ''
  const groupContext = group
    ? [
        `群聊：${group.name}`,
        `群记忆：${trimText(group.memory, 1000) || '无'}；群氛围：${trimText(group.vibe, 500) || '无'}`,
        `成员设定：${members.map((member) => `${member.name}（${trimText(member.systemPrompt, 260)}；关系 ${member.relationshipBase || '普通'}；心情 ${member.mood?.text || '未知'}）`).join('\n') || '无'}`,
      ].join('\n')
    : ''
  const assistContext = `【用户资料】
${userProfileText(settings)}

${privateContext || groupContext}

【近期社交事件】
${trimText(socialContext, 1200) || '无'}

【命中的世界书】
${worldbookContext || '无'}

【当前对话】
${history || '暂无历史，请写一句自然的开场回复。'}`
  const systemPrompt = getPromptTemplate(settings, 'aiReplyAssist', 'draft', { assistContext })
  if (!systemPrompt) throw new Error('代写助手提示词模块已屏蔽')
  const raw = await chatCompletion({
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    model: settings.model,
    maxTokens: 800,
    purpose: 'other',
    messages: [
      {
        role: 'system',
        content: `${systemPrompt}\n\n固定输出协议：只输出最终代写文本。`,
      },
      { role: 'user', content: '请生成' },
    ],
  })
  const suggestion = cleanDraft(raw)
  if (!suggestion) throw new Error('AI 未生成可用代写内容')
  return suggestion
}
