import { chatCompletion, type ChatMessage } from './deepseek'
import { displayName } from './contact'
import type { AppSettings, Contact, GroupEnergyLevel, Message } from '../types'

function truncate(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max)}...` : trimmed
}

function messageBody(message: Message): string {
  if (message.type === 'sticker') return `[表情: ${message.content}]`
  if (message.type === 'link') return `[链接: ${message.content}]`
  if (message.type === 'gift') return `[礼物: ${message.content}]`
  if (message.type === 'scheduleChange') return `[日程: ${message.content}]`
  return message.content
}

function groupHistoryText(messages: Message[], members: Contact[], userNickname: string): string {
  const byId = new Map(members.map((m) => [m.id, m]))
  return messages
    .slice(-16)
    .map((m) => {
      const name = m.role === 'user'
        ? (userNickname || '用户')
        : m.speakerContactId
          ? (byId.get(m.speakerContactId) ? displayName(byId.get(m.speakerContactId)!) : '某人')
          : '某人'
      return `${name}: ${messageBody(m)}`
    })
    .join('\n')
}

async function generateOutline(opts: {
  settings: AppSettings
  title: string
  premiseText: string
  historyText: string
  signal?: AbortSignal
}): Promise<string> {
  const systemPrompt = `你是“剧情大纲生成”实验功能。
任务：在主聊天模型开始写回复前，根据当前逻辑前提生成一个很短的未来对话大纲，用来指导下一轮回复。

只参考逻辑前提：身份、人设事实、关系、记忆、时间、日程、当前上下文、用户最新话语、群聊发言人/设置。
不要参考也不要生成“感觉/文采/润色/聊天腔/说话样例/全局风格提示词”。

输出要求：
- 只输出中文纯文本，不要JSON，不要Markdown代码块。
- 4到7行，每行尽量短。
- 必须包含：本轮核心判断、建议的回应方向、是否需要换话题/收束旧梗、禁止事项。
- 这是给主模型看的内部大纲，不要直接代写完整回复。`

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `【场景】${opts.title}

【逻辑前提】
${truncate(opts.premiseText, 5000)}

【最近聊天】
${truncate(opts.historyText || '（无）', 2500)}

请生成小型大纲。`,
    },
  ]

  const raw = await chatCompletion({
    apiKey: opts.settings.apiKey,
    baseUrl: opts.settings.baseUrl,
    model: opts.settings.utilityModel || opts.settings.model,
    purpose: 'other',
    messages,
    signal: opts.signal,
  })
  return raw.trim()
}

export async function generateGroupStoryOutline(opts: {
  settings: AppSettings
  groupName: string
  members: Contact[]
  speakers: Contact[]
  premiseText: string
  history: Message[]
  allowAiChatter: boolean
  energyLevel: GroupEnergyLevel
  signal?: AbortSignal
}): Promise<string> {
  const speakerText = opts.speakers.map((s, i) => `${i + 1}. ${displayName(s)}`).join('\n')
  return generateOutline({
    settings: opts.settings,
    title: `群聊：${opts.groupName}`,
    premiseText: `${opts.premiseText}

【本轮发言人】
${speakerText}

【群聊设置】
AI互聊: ${opts.allowAiChatter ? '开启' : '关闭'}
热闹程度: ${opts.energyLevel}`,
    historyText: groupHistoryText(opts.history, opts.members, opts.settings.userNickname),
    signal: opts.signal,
  })
}

export function storyOutlinePromptSection(outline: string): string {
  return outline.trim()
    ? `【剧情大纲 - 实验性内部指导】\n${outline.trim()}\n\n请按这个大纲控制逻辑、节奏和话题推进，但不要在回复里提到“大纲”。`
    : ''
}
