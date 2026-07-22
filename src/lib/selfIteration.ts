import { db } from '../db/db'
import { isModuleEnabled } from '../features'
import { useSettingsStore } from '../store/useSettingsStore'
import type { AppSettings, Contact, Message } from '../types'
import { extractJsonObject } from './aiProtocol'
import { chatCompletion, type ChatMessage } from './deepseek'
import { displayName } from './contact'
import { getPromptTemplate, promptModuleEnabled } from './promptModules'

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
  const learningContext = `已有全局模型：${opts.settings.selfIterationGlobalPrompt || '（暂无）'}
已有联系人专属模型：${opts.contact.selfIterationPrompt || '（暂无）'}
用户资料：昵称=${opts.settings.userNickname || '未设置'}；简介=${opts.settings.userBio || '无'}
联系人：${opts.contact.name}；关系=${opts.contact.relationshipBase || '朋友'} ${opts.contact.relationshipDynamic || ''}
人设摘要：${truncate(opts.contact.systemPrompt || '', 500)}
最近聊天记录：\n${opts.historyText}
最新一轮：用户=${opts.latestUserText}\n${opts.contact.name}=${opts.latestAssistantText}`
  const editable = getPromptTemplate(opts.settings, 'selfIteration', 'learning', { learningContext }) ?? ''
  return `${editable}\n\n固定输出协议：只输出JSON {"globalPrompt":"【用户表达习惯】...\\n【边界与偏好】...","contactPrompt":"【关系协商记录】..."}`
}

async function runTask(task: SelfIterationTask): Promise<void> {
  if (!isModuleEnabled('selfIteration')) return
  const settings = useSettingsStore.getState()
  if (!settings.apiKey || !promptModuleEnabled(settings, 'selfIteration')) return

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
