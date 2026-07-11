import { db } from '../db/db'
import { isModuleEnabled } from '../features'
import { useSettingsStore } from '../store/useSettingsStore'
import type { AppSettings, Contact, Message } from '../types'
import { extractJsonObject } from './aiProtocol'
import { chatCompletion, type ChatMessage } from './deepseek'
import { displayName } from './contact'

interface SelfIterationTask {
  conversationId: string
  contactId: string
  contactName: string
  latestUserText: string
  latestAssistantText: string
}

interface SelfIterationResult {
  globalPrompt: string
  contactPrompt: string
}

const queue: SelfIterationTask[] = []
let running = false

function truncate(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max)}...` : trimmed
}

function formatMessage(message: Message, contactName: string, userNickname: string): string {
  const speaker = message.role === 'user' ? (userNickname || '用户') : contactName
  if (message.type !== 'text') return `${speaker}: [${message.type}: ${message.content}]`
  return `${speaker}: ${message.content}`
}

function parseResult(raw: string): SelfIterationResult | null {
  let text = raw.trim()
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch) text = fenceMatch[1].trim()
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed?.globalPrompt === 'string' && typeof parsed?.contactPrompt === 'string') {
      return {
        globalPrompt: truncate(parsed.globalPrompt, 1800),
        contactPrompt: truncate(parsed.contactPrompt, 1400),
      }
    }
  } catch {
    const extracted = extractJsonObject(text)
    if (!extracted) return null
    try {
      const parsed = JSON.parse(extracted)
      if (typeof parsed?.globalPrompt === 'string' && typeof parsed?.contactPrompt === 'string') {
        return {
          globalPrompt: truncate(parsed.globalPrompt, 1800),
          contactPrompt: truncate(parsed.contactPrompt, 1400),
        }
      }
    } catch {
      return null
    }
  }
  return null
}

function buildLearningPrompt(opts: {
  settings: AppSettings
  contact: Contact
  historyText: string
  latestUserText: string
  latestAssistantText: string
}): string {
  return `你是这个聊天应用的“自我迭代”学习器。你不是聊天角色本人，你的任务是根据最新一轮对话更新两个提示词：

1. globalPrompt：全局用户边界与偏好模型，所有AI联系人都会复用。只包含：
- 表达习惯：口癖、常用词、语气词、标点、句长。1-2条即可，不用精细追踪，也不要写表情包或“短句连发”。
- 边界与偏好：用户明确表现出的“喜欢/讨厌被怎么对待”，比如是否讨厌机械追问、能否接受被反驳、喜欢直接结论还是陪伴分析。

2. contactPrompt：只给联系人“${opts.contact.name}”使用。只包含：
- 关系协商记录：这个联系人和用户之间形成的默契、边界、称呼、玩笑尺度、哪些反应被用户认可/否定。

重要原则：
- 不是模仿用户身份，也不是让AI复制用户原话；是学习“怎么和这个用户相处”。
- 保留角色差异。全局模型只改变节奏和期望理解，不要让所有角色变成同一种语气。
- 和 memory.style 分工明确：memory.style 负责“这一名联系人该如何调整语气贴合用户”；这里不要重复写泛泛的语气建议，只记录更稳定的边界、偏好、默契和协商结果。
- 不要编造没有证据的结论。证据弱就写“可能/倾向于”，证据强才写确定规则。
- 【去情景化 - 硬性要求】globalPrompt和contactPrompt里禁止出现本轮/历史聊天中的具体名词（食物名、地点名、宠物、天气、具体台词复述、具体事件）。只允许写“可迁移到其他话题的行为模式”的描述。自查方法：把这句话单独拿出来读，如果能看出“这是在讲哪次对话”，就是不合格的，必须重写成不含具体情景的行为规律。
- 单次对话里第一次出现的模式，倾向不写，或只写“可能”；同类反应在不同话题下至少出现两次再写成较确定的结论。
- 输出要短、可直接塞进聊天提示词。不要解释你的分析过程。

已有全局模型：
${opts.settings.selfIterationGlobalPrompt || '（暂无）'}

已有该联系人专属模型：
${opts.contact.selfIterationPrompt || '（暂无）'}

用户资料：
昵称: ${opts.settings.userNickname || '未设置'}
简介: ${opts.settings.userBio || '无'}

联系人信息：
名字: ${opts.contact.name}
关系: ${opts.contact.relationshipBase || '朋友'} ${opts.contact.relationshipDynamic || ''}
人设摘要: ${truncate(opts.contact.systemPrompt || '', 500)}

最近聊天记录：
${opts.historyText}

最新一轮：
用户: ${opts.latestUserText}
${opts.contact.name}: ${opts.latestAssistantText}

请输出严格JSON，不要markdown：
{
  "globalPrompt": "【用户表达习惯】...\\n【边界与偏好】...",
  "contactPrompt": "【关系协商记录】..."
}`
}

async function runTask(task: SelfIterationTask): Promise<void> {
  if (!isModuleEnabled('selfIteration')) return
  const settings = useSettingsStore.getState()
  if (!settings.apiKey) return

  const contact = await db.contacts.get(task.contactId)
  if (!contact) return

  const history = await db.messages.where('conversationId').equals(task.conversationId).sortBy('createdAt')
  const historyText = history
    .slice(-12)
    .map((message) => formatMessage(message, task.contactName, settings.userNickname))
    .join('\n')

  const prompt = buildLearningPrompt({
    settings,
    contact,
    historyText,
    latestUserText: task.latestUserText,
    latestAssistantText: task.latestAssistantText,
  })

  const raw = await chatCompletion({
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    model: settings.model,
    purpose: 'memory',
    automatic: true,
    messages: [{ role: 'system', content: prompt } satisfies ChatMessage],
    jsonMode: true,
  })
  const parsed = parseResult(raw)
  if (!parsed) {
    console.warn('[selfIteration] 学习结果解析失败', raw.slice(0, 200))
    return
  }

  const now = Date.now()
  useSettingsStore.getState().setSettings({
    selfIterationGlobalPrompt: parsed.globalPrompt,
    selfIterationUpdatedAt: now,
  })
  await db.contacts.update(contact.id, {
    selfIterationPrompt: parsed.contactPrompt,
    selfIterationUpdatedAt: now,
  })
  console.log(`[selfIteration] 已更新学习模型 contact=${displayName(contact)}`)
}

async function drainQueue(): Promise<void> {
  if (running) return
  running = true
  try {
    while (queue.length > 0) {
      const task = queue.shift()
      if (!task) continue
      try {
        await runTask(task)
      } catch (err) {
        console.warn('[selfIteration] 学习任务失败', err)
      }
    }
  } finally {
    running = false
    if (queue.length > 0) void drainQueue()
  }
}

export function enqueueSelfIterationTask(task: SelfIterationTask): void {
  if (!isModuleEnabled('selfIteration')) return
  queue.push(task)
  void drainQueue()
}
