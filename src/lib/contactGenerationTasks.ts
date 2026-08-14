import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import type {
  AppSettings,
  Contact,
  ContactGenerationError,
  ContactGenerationInput,
  ContactGenerationMethod,
  ContactGenerationStatus,
  ContactGenerationTask,
  ContactMemory,
  ContactRelationLink,
} from '../types'
import { useSettingsStore } from '../store/useSettingsStore'
import { buildPersonaGenerationPrompt, composeCanonicalPersona, diagnosePersonaGeneration, type PersonaGenerationResult } from './prompt'
import { speechVoiceGenerationContext } from './speechProviders'
import { chatCompletionText } from './deepseek'
import { completedTopLevelJsonFields } from './incrementalJson'
import { selectedWorldbookEntriesText, retrieveWorldbookContext } from './worldbook'
import { extractWorldbookPersonaCanon, type WorldbookPersonaCanon } from './worldbookPersonaCanon'
import { pickAvatarCategory } from './avatarCategory'
import { randomAnimeAvatar, searchPexelsPhoto } from './photoSearch'
import { generateRemoteImage } from './remoteMedia'
import { composeImagePrompt, visualIdentitySeed } from './imageAssets'
import { initialWarmthForBase } from './relationship'
import { randomAvatarColor } from './colors'
import { employmentPatch } from './career'
import { displayName } from './contact'
import { syncContactLocationsAt } from './locations'
import { activePromptPreset, clonePromptModules } from './promptPresets'
import { generatePersonaWithTools } from './personaAgentTools'
import { addContactToWorldSnapshots } from './worldSnapshots'

const ACTIVE_STATUSES: ContactGenerationStatus[] = [
  'preparing', 'retrieving_context', 'extracting_canon', 'generating', 'validating', 'fetching_avatar', 'committing',
]

let runningTaskId: string | null = null
let queueSelectionInProgress = false
let queueWakeRequested = false
const controllers = new Map<string, AbortController>()
let initializationPromise: Promise<void> | null = null
let runtimeGeneration = 0

export function stageLabel(status: ContactGenerationStatus, mode: ContactGenerationTask['experienceMode']): string {
  if (mode === 'immersive') {
    const labels: Partial<Record<ContactGenerationStatus, string>> = {
      queued: '等待开始寻找', preparing: '正在确认你的寻找偏好', retrieving_context: '正在扩大寻找范围', extracting_canon: '正在核对相关资料', generating: '正在匹配合适的联系人', validating: '正在确认对方资料', fetching_avatar: '正在尝试建立联系', awaiting_review: '已找到联系人，等待确认', committing: '正在添加到联系人', failed: '寻找暂时中断', paused: '寻找已暂停', cancelled: '已取消寻找', completed: '已找到联系人',
    }
    return labels[status] ?? '正在寻找联系人'
  }
  const labels: Partial<Record<ContactGenerationStatus, string>> = {
    queued: '等待生成', preparing: '正在整理创建条件', retrieving_context: '正在读取世界书', extracting_canon: '正在提取世界书正史', generating: '正在生成人物资料', validating: '正在检查生成结果', fetching_avatar: '正在匹配头像', awaiting_review: '初稿已完成，待确认', committing: '正在保存联系人', failed: '生成失败', paused: '任务已暂停', cancelled: '任务已取消', completed: '联系人已创建',
  }
  return labels[status] ?? '正在生成联系人'
}

export async function createContactGenerationTask(options: {
  method: ContactGenerationMethod
  experienceMode?: ContactGenerationTask['experienceMode']
  input: ContactGenerationInput
  personaDraft?: PersonaGenerationResult
}): Promise<string> {
  await initializeContactGenerationTasks()
  const settings = useSettingsStore.getState()
  const now = Date.now()
  const promptPreset = activePromptPreset(settings)
  const task: ContactGenerationTask = {
    id: uuid(),
    experienceMode: options.experienceMode ?? settings.experienceMode,
    method: options.method,
    status: 'queued',
    stageLabel: stageLabel('queued', options.experienceMode ?? settings.experienceMode),
    input: structuredClone(options.input),
    provider: settings.aiProvider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    utilityModel: settings.utilityModel,
    promptModulesSnapshot: clonePromptModules(promptPreset.modules),
    promptPresetSourceId: promptPreset.id,
    promptPresetSourceName: promptPreset.name,
    personaDraft: options.personaDraft ? structuredClone(options.personaDraft) : undefined,
    attempt: 0,
    createdAt: now,
    updatedAt: now,
  }
  await db.contactGenerationTasks.add(task)
  void drainContactGenerationQueue()
  return task.id
}

/** Called once on app boot. Work interrupted by process death requires explicit user consent to resume. */
export async function initializeContactGenerationTasks(): Promise<void> {
  if (!initializationPromise) {
    initializationPromise = (async () => {
      const interrupted = await db.contactGenerationTasks.filter((task) => ACTIVE_STATUSES.includes(task.status) || task.status === 'queued').toArray()
      const now = Date.now()
      await Promise.all(interrupted.map((task) => db.contactGenerationTasks.update(task.id, {
        status: 'paused',
        stageLabel: stageLabel('paused', task.experienceMode),
        error: interruptionError(task),
        updatedAt: now,
      })))
    })()
  }
  await initializationPromise
}

export async function resumeContactGenerationTask(taskId: string): Promise<void> {
  const task = await db.contactGenerationTasks.get(taskId)
  if (!task || !['paused', 'failed'].includes(task.status)) return
  await db.contactGenerationTasks.update(taskId, {
    status: 'queued', stageLabel: stageLabel('queued', task.experienceMode), error: undefined, updatedAt: Date.now(),
  })
  void drainContactGenerationQueue()
}

export async function confirmContactGenerationDraft(taskId: string, draft: PersonaGenerationResult): Promise<void> {
  const task = await db.contactGenerationTasks.get(taskId)
  if (!task || task.status !== 'awaiting_review') return
  await db.contactGenerationTasks.update(taskId, {
    personaDraft: structuredClone(draft), status: 'queued', stageLabel: '等待保存联系人', error: undefined, updatedAt: Date.now(),
  })
  void drainContactGenerationQueue()
}

export async function cancelContactGenerationTask(taskId: string): Promise<void> {
  controllers.get(taskId)?.abort()
  const task = await db.contactGenerationTasks.get(taskId)
  if (!task) return
  await db.contactGenerationTasks.update(taskId, {
    status: 'cancelled', stageLabel: stageLabel('cancelled', task.experienceMode), updatedAt: Date.now(),
  })
}

export async function pauseContactGenerationTask(taskId: string): Promise<void> {
  const task = await db.contactGenerationTasks.get(taskId)
  if (!task) return
  controllers.get(taskId)?.abort()
  await db.contactGenerationTasks.update(taskId, {
    status: 'paused',
    stageLabel: stageLabel('paused', task.experienceMode),
    error: { code: 'USER_PAUSED', stage: task.status, message: '任务已暂停，可随时继续', technicalMessage: 'Paused by user', retryable: true, attempt: task.attempt, provider: task.provider, model: task.model, occurredAt: Date.now() },
    updatedAt: Date.now(),
  })
}

export async function deleteContactGenerationTask(taskId: string): Promise<void> {
  controllers.get(taskId)?.abort()
  await db.contactGenerationTasks.delete(taskId)
}

export async function cancelAllContactGenerationTasks(): Promise<void> {
  runtimeGeneration += 1
  queueWakeRequested = false
  for (const controller of controllers.values()) controller.abort()
  controllers.clear()
  runningTaskId = null
  await db.contactGenerationTasks.clear()
}

export async function markPersistedContactGenerationTasksPaused(): Promise<void> {
  const tasks = await db.contactGenerationTasks.filter((task) => ACTIVE_STATUSES.includes(task.status) || task.status === 'queued').toArray()
  await Promise.all(tasks.map((task) => db.contactGenerationTasks.update(task.id, {
    status: 'paused', stageLabel: stageLabel('paused', task.experienceMode), error: interruptionError(task), updatedAt: Date.now(),
  })))
}

export function formatContactGenerationDiagnostic(task: ContactGenerationTask): string {
  const error = task.error
  return [
    '联系人生成故障信息',
    `任务编号：${task.id}`,
    `创建方式：${task.method === 'precision' ? '精细创建' : '帮我找人'}`,
    `阶段：${error?.stage ?? task.status}`,
    `错误代码：${error?.code ?? 'UNKNOWN'}`,
    `说明：${error?.message ?? task.stageLabel}`,
    `技术原因：${error?.technicalMessage ?? '无'}`,
    `供应商：${error?.provider ?? task.provider}`,
    `模型：${error?.model ?? task.model}`,
    `自动/手动尝试次数：${task.attempt}`,
    `返回字符数：${error?.responseChars ?? task.rawOutput?.length ?? 0}`,
    `校验结果：${error?.validation?.issues.map((issue) => issue.field ? `${issue.field}（${issue.message}）` : issue.message).join('；') ?? '无'}`,
    error?.validation?.repair ? `自动修复后：${error.validation.repair.issues.map((issue) => issue.field ? `${issue.field}（${issue.message}）` : issue.message).join('；') || '通过'}` : '',
    `发生时间：${new Date(error?.occurredAt ?? task.updatedAt).toLocaleString()}`,
  ].join('\n')
}

async function setStage(task: ContactGenerationTask, status: ContactGenerationStatus, patch: Partial<ContactGenerationTask> = {}) {
  task.status = status
  task.stageLabel = stageLabel(status, task.experienceMode)
  Object.assign(task, patch)
  task.updatedAt = Date.now()
  await db.contactGenerationTasks.update(task.id, { status, stageLabel: task.stageLabel, updatedAt: task.updatedAt, ...patch })
}

async function drainContactGenerationQueue(): Promise<void> {
  if (runningTaskId) return
  if (queueSelectionInProgress) {
    queueWakeRequested = true
    return
  }
  queueSelectionInProgress = true
  const generation = runtimeGeneration
  let task: ContactGenerationTask | undefined
  try {
    task = await db.contactGenerationTasks.where('status').equals('queued').sortBy('createdAt').then((rows) => rows[0])
    if (generation !== runtimeGeneration) return
    if (task) runningTaskId = task.id
  } finally {
    queueSelectionInProgress = false
  }
  if (!task) {
    if (queueWakeRequested) {
      queueWakeRequested = false
      void drainContactGenerationQueue()
    }
    return
  }
  queueWakeRequested = false
  const controller = new AbortController()
  controllers.set(task.id, controller)
  try {
    await runTask(task, controller.signal)
  } catch (error) {
    if (controller.signal.aborted) return
    const latest = await db.contactGenerationTasks.get(task.id)
    if (!latest || latest.status === 'cancelled') return
    const detail = classifyError(error, latest)
    await db.contactGenerationTasks.update(task.id, {
      status: 'failed', stageLabel: stageLabel('failed', latest.experienceMode), error: detail, updatedAt: Date.now(),
    })
  } finally {
    controllers.delete(task.id)
    runningTaskId = null
    if (generation === runtimeGeneration) void drainContactGenerationQueue()
  }
}

async function runTask(task: ContactGenerationTask, signal: AbortSignal): Promise<void> {
  task.attempt += 1
  await setStage(task, 'preparing', { attempt: task.attempt, startedAt: task.startedAt ?? Date.now(), error: undefined })
  const liveSettings = useSettingsStore.getState()
  if (!liveSettings.apiKey.trim()) throw codedError('AUTH_MISSING', '还没有配置 API Key，请先到“我－设置”中填写', false)
  const settings = { ...liveSettings, aiProvider: task.provider, baseUrl: task.baseUrl, model: task.model, utilityModel: task.utilityModel } as AppSettings

  if (!task.personaDraft) {
    await preparePersona(task, settings, signal)
    if (task.method === 'precision') {
      await setStage(task, 'awaiting_review')
      return
    }
  }
  await prepareAvatar(task, settings)
  await commitTask(task)
}

async function preparePersona(task: ContactGenerationTask, settings: AppSettings, signal: AbortSignal) {
  const input = task.input
  let worldbookText = task.worldbookText
  if (worldbookText === undefined) {
    await setStage(task, 'retrieving_context')
    const query = [input.personalityTags.join(' '), input.ageRange, input.gender, input.relationship, input.occupation, input.hobbies.join(' '), input.roleDescription, input.personaSetting].filter(Boolean).join('\n')
    const [selectedText, retrievedText] = await Promise.all([
      selectedWorldbookEntriesText(input.selectedWorldbookEntryIds),
      retrieveWorldbookContext(query, { maxEntries: 8, maxChars: 6500, includeHighPriorityFallback: true, worldviewId: input.worldviewId }),
    ])
    worldbookText = [
      selectedText ? `【用户明确选择的资料库参考资料】\n${selectedText}` : '',
      input.importedWorldbook?.entries.length ? `【角色卡内嵌世界书参考资料】\n${input.importedWorldbook.entries.map((entry) => `【${entry.title}】\n${entry.content}`).join('\n\n')}` : '',
      retrievedText,
    ].filter(Boolean).join('\n\n')
    task.worldbookText = worldbookText
    await db.contactGenerationTasks.update(task.id, { worldbookText, updatedAt: Date.now() })
  }

  let canon = task.canon as WorldbookPersonaCanon | undefined
  if (!canon) {
    await setStage(task, 'extracting_canon')
    const contacts = await db.contacts.toArray()
    try {
      canon = await extractWorldbookPersonaCanon({
        settings,
        worldbookText,
        requestedCharacter: [input.roleDescription, input.personaSetting, input.relationship].filter(Boolean).join('\n'),
        existingContactNames: contacts.flatMap((contact) => [contact.name, contact.realName, contact.nickname, displayName(contact)].filter((name): name is string => !!name)),
        signal,
      })
    } catch (error) {
      const explicitlyBound = input.selectedWorldbookEntryIds.length > 0 || !!input.importedWorldbook?.entries.length
      if (explicitlyBound) throw codedError('WORLDBOOK_CANON_FAILED', error instanceof Error ? error.message : String(error), true)
      canon = { relationship: '', sharedHistory: '', facts: [], boundaries: [], initialMemories: [] }
    }
    task.canon = canon
    await db.contactGenerationTasks.update(task.id, { canon, updatedAt: Date.now() })
  }

  const relationship = input.relationship || canon.relationship
  const sharedHistory = input.sharedHistory || canon.sharedHistory
  const personaExtra = [input.roleDescription, input.personaSetting, await interpersonalSetting(input)].filter(Boolean).join('\n\n')
  const canonText = canon.initialMemories.length || canon.facts.length || canon.relationship
    ? `【已结构化提取的世界书正史——输出必须逐项覆盖】\n${JSON.stringify(canon)}`
    : ''
  const avatarCategory = pickAvatarCategory(input.personalityTags)
  const voiceContext = speechVoiceGenerationContext(settings)
  const prompt = buildPersonaGenerationPrompt({
    personalityTags: input.personalityTags,
    ageRange: input.ageRange,
    gender: input.gender,
    relationship,
    personalityTrait: input.personalityTrait,
    hobbies: input.hobbies,
    sharedHistory,
    draftMode: task.method === 'precision',
    extra: personaExtra,
    occupation: input.occupation,
  }, avatarCategory, task.promptModulesSnapshot ?? settings.promptModules, [worldbookText, canonText].filter(Boolean).join('\n\n'), voiceContext)
  if (!prompt.trim()) throw codedError('PROMPT_DISABLED', '女娲创建提示词模块已屏蔽', false)

  await setStage(task, 'generating', { rawOutput: '', partialFields: {}, generationActivity: ['正在启动人物生成'], validationRepairAttempted: false })
  let lastProgressWrite = 0
  const generated = await generatePersonaWithTools({
    settings,
    systemPrompt: prompt,
    taskId: task.id,
    worldviewId: input.worldviewId,
    voiceContext,
    signal,
    onProgress: async (progress) => {
      const activity = [...(task.generationActivity ?? [])]
      const milestoneChanged = !!progress.message && activity.at(-1) !== progress.message
      if (milestoneChanged) activity.push(progress.message)
      task.generationActivity = activity.slice(-8)
      if (progress.raw !== undefined) {
        task.rawOutput = progress.raw
        task.partialFields = completedTopLevelJsonFields(progress.raw)
      }
      const now = Date.now()
      if (!milestoneChanged && now - lastProgressWrite < 90) return
      lastProgressWrite = now
      await db.contactGenerationTasks.update(task.id, {
        generationActivity: task.generationActivity,
        rawOutput: task.rawOutput,
        partialFields: task.partialFields,
        updatedAt: now,
      })
    },
  })
  let raw = generated.raw
  task.rawOutput = raw
  task.partialFields = completedTopLevelJsonFields(raw)
  await setStage(task, 'validating', { rawOutput: raw, partialFields: task.partialFields })
  const originalValidation = diagnosePersonaGeneration(raw)
  let parsed = originalValidation.result
  let validationDiagnostics = originalValidation.diagnostics
  await db.contactGenerationTasks.update(task.id, { validationDiagnostics, updatedAt: Date.now() })
  if (!parsed) {
    task.validationRepairAttempted = true
    await db.contactGenerationTasks.update(task.id, { validationRepairAttempted: true, updatedAt: Date.now() })
    const repaired = await chatCompletionText({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.utilityModel || settings.model,
      provider: settings.aiProvider,
      messages: [
        { role: 'system', content: `你是人物资料 JSON 修复器。保留候选内容的已有事实，修复截断、引号、逗号、字段类型和缺失的必要字段。只能输出一个合法 JSON 对象。至少必须包含 name、persona、speechExamples、visualIdentity、gender、ageRange、relationship、occupation、realName、nickname、birthday、initialMemories、monthlySalary、schedule、avatarKeyword${voiceContext ? '、speechVoiceId、speechStyleInstruction；speechVoiceId只能使用：' + voiceContext.options.map((option) => option.id).join('、') : ''}。speechExamples 必须正好10条互不重复的“[场景] 实际消息”；persona 是唯一人设正文，程序会把示例合并进去。不要解释。` },
        { role: 'user', content: `待修复候选：\n${raw.slice(0, 16000)}` },
      ],
      jsonMode: true,
      thinking: 'disabled',
      temperature: 0,
      purpose: 'persona',
      signal,
      trace: { turnId: task.id, stage: 'other' },
    })
    const repairedValidation = diagnosePersonaGeneration(repaired)
    parsed = repairedValidation.result
    validationDiagnostics = { ...originalValidation.diagnostics, repairAttempted: true, repair: repairedValidation.diagnostics }
    task.validationDiagnostics = validationDiagnostics
    await db.contactGenerationTasks.update(task.id, { validationDiagnostics, updatedAt: Date.now() })
    if (parsed) {
      raw = repaired
      task.rawOutput = repaired
      task.partialFields = completedTopLevelJsonFields(repaired)
      await db.contactGenerationTasks.update(task.id, { rawOutput: repaired, partialFields: task.partialFields, updatedAt: Date.now() })
    }
  }
  if (!parsed) {
    const finalDiagnostics = validationDiagnostics.repair ?? validationDiagnostics
    const firstIssue = finalDiagnostics.issues[0]
    const code = validationDiagnostics.repairAttempted ? 'PERSONA_REPAIR_FAILED'
      : firstIssue?.code === 'empty_output' ? 'PERSONA_EMPTY_OUTPUT'
        : firstIssue?.code === 'json_truncated' ? 'PERSONA_JSON_TRUNCATED'
          : firstIssue?.code === 'json_invalid' ? 'PERSONA_JSON_INVALID'
            : firstIssue?.code === 'required_field_missing' ? 'PERSONA_REQUIRED_FIELD_MISSING'
              : 'PERSONA_REQUIRED_FIELD_INVALID'
    throw codedError(code, firstIssue?.message ?? '人物资料校验未通过', true, {
      responseChars: raw.length,
      failedFields: finalDiagnostics.issues.map((issue) => issue.field).filter((field): field is string => !!field),
      validation: validationDiagnostics,
    })
  }
  if (canon.initialMemories.length) {
    const existing = parsed.initialMemories ?? []
    const seen = new Set(existing.map((item) => `${item.period}|${item.summary}`))
    parsed = {
      ...parsed,
      relationship: relationship || parsed.relationship || canon.relationship,
      initialMemories: [...canon.initialMemories.filter((item) => !seen.has(`${item.period}|${item.summary}`)), ...existing].slice(0, 12),
      persona: composeCanonicalPersona({
        persona: parsed.persona,
        profile: { facts: canon.facts ?? [], boundaries: canon.boundaries ?? [], habits: [], behaviorAnchors: [] },
      }),
    }
  }
  if (task.method === 'precision') parsed.initialWarmth ??= initialWarmthForBase(relationship || parsed.relationship || '朋友', input.personalityTrait)
  const generatedVoiceId = parsed.speechVoiceId
  if (voiceContext && !voiceContext.options.some((option) => option.id === generatedVoiceId)) {
    parsed = { ...parsed, speechVoiceId: undefined, speechStyleInstruction: undefined }
  }
  parsed = {
    ...parsed,
    persona: composeCanonicalPersona({ persona: parsed.persona, speechSamples: parsed.speechExamples }),
    speechExamples: undefined,
  }
  task.personaDraft = parsed
  await db.contactGenerationTasks.update(task.id, { personaDraft: parsed, updatedAt: Date.now() })
}

async function prepareAvatar(task: ContactGenerationTask, settings: AppSettings) {
  if (task.finalAvatar) return
  await setStage(task, 'fetching_avatar')
  let finalAvatar = task.input.avatar
  let avatarPhotographer: string | undefined
  let avatarPhotographerUrl: string | undefined
  if (!task.input.avatarManuallySet && task.personaDraft) {
    try {
      const category = pickAvatarCategory(task.input.personalityTags)
      const avatarQuery = task.personaDraft.avatarKeyword || category
      const photo = settings.avatarImageSource === 'anime'
        ? await randomAnimeAvatar(settings.animeNsfwEnabled)
        : settings.avatarImageSource === 'generated'
          ? await generateRemoteImage(settings, composeImagePrompt({
              scene: `square profile avatar, head-and-shoulders portrait, ${avatarQuery}`,
              kind: 'portrait',
              contacts: [{
                id: 'avatar-draft', name: task.personaDraft.name, avatar: '', avatarColor: '',
                systemPrompt: task.personaDraft.persona, visualIdentity: task.personaDraft.visualIdentity,
                createdAt: 0, memoryFacts: '', memoryStyle: '', memoryUpdatedAt: 0, memoryMessageCursor: 0,
                relationshipBase: task.personaDraft.relationship || '', relationshipDynamic: '',
              }],
              includeUser: false, settings,
            }), { seed: visualIdentitySeed(task.personaDraft.visualIdentity || task.personaDraft.name) })
          : await searchPexelsPhoto(settings.pexelsApiKey, avatarQuery, 'square')
      if (photo) { finalAvatar = photo.url; avatarPhotographer = 'photographer' in photo ? photo.photographer : undefined; avatarPhotographerUrl = 'photographerUrl' in photo ? photo.photographerUrl : undefined }
    } catch {}
  }
  task.finalAvatar = finalAvatar
  task.avatarPhotographer = avatarPhotographer
  task.avatarPhotographerUrl = avatarPhotographerUrl
  await db.contactGenerationTasks.update(task.id, { finalAvatar, avatarPhotographer, avatarPhotographerUrl, updatedAt: Date.now() })
}

async function commitTask(task: ContactGenerationTask) {
  const parsed = task.personaDraft
  if (!parsed) throw codedError('PERSONA_MISSING', '没有可保存的人物资料', false)
  await setStage(task, 'committing')
  const existingResult = task.resultContactId ? await db.contacts.get(task.resultContactId) : undefined
  if (existingResult) { await db.contactGenerationTasks.delete(task.id); return }

  const input = task.input
  const contactId = task.resultContactId || uuid()
  const conversationId = uuid()
  const now = Date.now()
  const relationship = input.relationship || parsed.relationship || '朋友'
  const initialSharedMemory = input.sharedHistory || (task.canon as WorldbookPersonaCanon | undefined)?.sharedHistory || ''
  const automaticWarmth = initialWarmthForBase(relationship, input.personalityTrait)
  const warmth = input.initialWarmthMode === 'custom'
    ? Math.max(-100, Math.min(100, Math.round(input.initialWarmth ?? automaticWarmth)))
    : task.method === 'precision' ? parsed.initialWarmth ?? automaticWarmth : automaticWarmth
  const boundWorldbookEntryIds = Array.from(new Set([...input.selectedWorldbookEntryIds, ...(input.importedWorldbook?.entries.map((entry) => entry.id) ?? [])]))
  const contacts = await db.contacts.toArray()
  const existingContactIds = new Set(contacts.map((contact) => contact.id))
  const byName = new Map(contacts.flatMap((contact) => [contact.name, contact.realName, contact.nickname, displayName(contact)].filter((name): name is string => !!name).map((name) => [name.trim().toLocaleLowerCase(), contact.id] as const)))
  const voiceContext = speechVoiceGenerationContext(useSettingsStore.getState())
  const generatedSpeechVoices = voiceContext && parsed.speechVoiceId && voiceContext.options.some((option) => option.id === parsed.speechVoiceId)
    ? { [voiceContext.provider]: { voiceId: parsed.speechVoiceId, styleInstruction: parsed.speechStyleInstruction, source: 'ai' as const, assignedAt: now } }
    : undefined

  try {
  await db.transaction('rw', [db.contacts, db.conversations, db.messages, db.contactRelations, db.contactMemories, db.personaCreationRecords, db.contactGenerationTasks], async () => {
    const contact: Contact = {
      id: contactId,
      name: parsed.name,
      realName: input.realName?.trim() || parsed.realName || parsed.name,
      nickname: input.nickname?.trim() || (task.method === 'precision' ? parsed.nickname : parsed.name) || parsed.name,
      gender: input.gender || parsed.gender || '',
      birthday: input.birthday?.trim() || parsed.birthday || fallbackBirthday(parsed.ageRange || input.ageRange),
      avatar: task.finalAvatar || input.avatar,
      avatarColor: randomAvatarColor(),
      visualIdentity: parsed.visualIdentity,
      visualSeed: visualIdentitySeed(parsed.visualIdentity || parsed.name),
      avatarPhotographer: task.avatarPhotographer,
      avatarPhotographerUrl: task.avatarPhotographerUrl,
      systemPrompt: composeCanonicalPersona({
        persona: parsed.persona,
        traitName: input.personalityTrait,
        traitContent: input.personalityTraitContent,
      }),
      creatorProfile: { personalityTendencies: input.personalityTags, age: input.ageRange || parsed.ageRange || '', gender: input.gender || parsed.gender || '', relationship, occupation: input.occupation || parsed.occupation || '', hobbies: input.hobbies, notes: input.roleDescription, sharedHistory: input.sharedHistory },
      speechVoices: generatedSpeechVoices,
      createdAt: now,
      memoryFacts: '', memoryStyle: '', memoryUpdatedAt: 0, memoryMessageCursor: 0,
      ...(input.relationshipEnabled ? { warmth } : {}),
      relationshipBase: relationship,
      initialRelationshipBase: relationship,
      relationshipDynamic: '',
      residence: (() => {
        const profile = `${relationship} ${input.occupation || parsed.occupation || ''} ${parsed.persona}`
        const cohabitsWithUser = /女仆|佣人|管家|保姆|住家|同居|室友|妹妹|姐姐|弟弟|哥哥|家人|妻子|丈夫|未婚妻|未婚夫/.test(profile)
        const student = /学生|大学|高中|初中|学校|上课/.test(profile)
        return {
          locationId: cohabitsWithUser ? 'home-living' : student ? 'student-dorm-room' : 'riverside-apartment-room',
          kind: cohabitsWithUser ? 'player_home' as const : student ? 'dorm' as const : 'apartment' as const,
          cohabitsWithUser,
          establishedBy: 'generation' as const,
        }
      })(),
      schedule: parsed.schedule,
      initialSchedule: parsed.schedule,
      scheduleOverrides: [],
      worldbookEntryIds: boundWorldbookEntryIds,
      experienceCursorAt: now,
      worldviewId: input.worldviewId || useSettingsStore.getState().activeWorldId || useSettingsStore.getState().defaultWorldviewId,
      promptModulesSnapshot: clonePromptModules(task.promptModulesSnapshot ?? useSettingsStore.getState().promptModules),
      promptPresetSourceId: task.promptPresetSourceId,
      promptPresetSourceName: task.promptPresetSourceName,
      promptSnapshotUpdatedAt: now,
      acquisition: input.recommendation ? {
        type: 'recommendation',
        recommenderContactId: input.recommendation.recommenderContactId,
        recommenderName: input.recommendation.recommenderName,
        sourceMessageId: input.recommendation.sourceMessageId,
        acceptedAt: input.recommendation.acceptedAt,
      } : undefined,
      ...(input.careerEnabled && (input.occupation || parsed.occupation) ? employmentPatch(input.occupation || parsed.occupation || '', parsed.monthlySalary ?? 6000) : {}),
    }
    await db.contacts.add(contact)
    if (input.recommendation) {
      const sourceMessage = await db.messages.get(input.recommendation.sourceMessageId)
      if (sourceMessage?.link?.app === 'contact_recommendation') {
        await db.messages.update(sourceMessage.id, {
          link: { ...sourceMessage.link, data: { ...sourceMessage.link.data, status: 'accepted', contactId, resolvedAt: now } },
        })
      }
    }
    await db.conversations.add({ id: conversationId, contactId, pinned: false, createdAt: now, updatedAt: now })
    if (input.importedFirstMessage?.trim()) {
      await db.messages.add({ id: uuid(), conversationId, role: 'assistant', type: 'text', content: input.importedFirstMessage.trim(), createdAt: now + 1 })
      await db.conversations.update(conversationId, { updatedAt: now + 1 })
    }
    await addInitialRelations(contact, input.relations, contacts, now)
    const initialMemories: ContactMemory[] = []
    for (const experience of parsed.initialMemories ?? []) {
      const participantIds = [contactId, ...Array.from(new Set([
          ...(((experience as typeof experience & { relatedContactIds?: string[] }).relatedContactIds) ?? []).filter((id) => existingContactIds.has(id)),
          ...experience.relatedContactNames.map((name) => byName.get(name.trim().toLocaleLowerCase())).filter((id): id is string => !!id),
        ]))]
      for (const ownerId of participantIds) initialMemories.push({
        id: uuid(), contactId: ownerId, scope: participantIds.length > 1 ? 'interpersonal' : 'private',
        relatedContactIds: participantIds.filter((id) => id !== ownerId), category: '重要事件', kind: 'relationship_event',
        content: [experience.period, experience.title, experience.summary].filter(Boolean).join('｜'), tags: ['创建记忆'],
        importance: Math.max(0, Math.min(1, experience.importance / 100)), emotionalWeight: 0.5, confidence: 1,
        sourceMessageIds: [], createdAt: now, updatedAt: now, usageCount: 0,
      })
    }
    if (initialSharedMemory) initialMemories.push({ id: uuid(), contactId, scope: 'private', category: '关系动态', kind: 'relationship_event', content: initialSharedMemory, tags: ['初始记忆'], importance: 0.85, emotionalWeight: 0.7, confidence: 1, sourceMessageIds: [], createdAt: now, updatedAt: now, usageCount: 0 })
    if (initialMemories.length) await db.contactMemories.bulkAdd(initialMemories)
    await db.personaCreationRecords.add({
      id: uuid(), sourceContactId: contactId, name: parsed.name, realName: parsed.realName, nickname: parsed.nickname, birthday: parsed.birthday,
      gender: input.gender || parsed.gender, ageRange: input.ageRange || parsed.ageRange, relationship, occupation: input.occupation || parsed.occupation,
      initialWarmth: input.relationshipEnabled ? warmth : undefined, hobbies: input.hobbies,
      personaSetting: input.personaSetting || parsed.persona, roleDescription: input.roleDescription || undefined, persona: parsed.persona, visualIdentity: parsed.visualIdentity,
      schedule: parsed.schedule, avatarKeyword: parsed.avatarKeyword, monthlySalary: parsed.monthlySalary,
      sharedHistory: input.sharedHistory || undefined, createdAt: now,
    })
    await db.contactGenerationTasks.delete(task.id)
  })
  } catch (error) {
    throw codedError('DATABASE_COMMIT_FAILED', error instanceof Error ? error.message : String(error), true)
  }
  const createdContact = await db.contacts.get(contactId)
  if (createdContact) await addContactToWorldSnapshots(createdContact)
  if (input.locationEnabled) void syncContactLocationsAt(new Date(now)).catch(() => undefined)
}

async function addInitialRelations(contact: Contact, relations: ContactGenerationInput['relations'], contacts: Contact[], now: number) {
  const byId = new Map(contacts.map((item) => [item.id, item]))
  const links: ContactRelationLink[] = []
  const memories: ContactMemory[] = []
  for (const relation of relations) {
    const other = byId.get(relation.targetContactId)
    if (!other || other.id === contact.id) continue
    const pairId = uuid()
    links.push(
      { id: uuid(), pairId, fromContactId: contact.id, toContactId: other.id, label: relation.label, createdAt: now },
      { id: uuid(), pairId, fromContactId: other.id, toContactId: contact.id, label: relation.label, createdAt: now },
    )
    const makeMemory = (contactId: string, target: Contact): ContactMemory => ({ id: uuid(), contactId, scope: 'interpersonal', relatedContactIds: [target.id], category: '关系动态', kind: 'relationship_event', content: `${displayName(target)}是你的${relation.label}，这是创建角色时设定的 AI 关系事实，不可随意改称朋友。`, tags: ['AI关系', relation.label, displayName(target)], importance: 0.85, emotionalWeight: 0.35, confidence: 1, sourceMessageIds: [], createdAt: now, updatedAt: now, usageCount: 0 })
    memories.push(makeMemory(contact.id, other), makeMemory(other.id, contact))
  }
  if (links.length) await db.contactRelations.bulkAdd(links)
  if (memories.length) await db.contactMemories.bulkAdd(memories)
}

async function interpersonalSetting(input: ContactGenerationInput) {
  const contacts = await db.contacts.bulkGet(input.relations.map((row) => row.targetContactId))
  return input.relations.map((row, index) => contacts[index] ? `与已有角色“${displayName(contacts[index] as Contact)}”的关系：${row.label}` : '').filter(Boolean).join('\n')
}

function fallbackBirthday(ageText: string) {
  const ages = [...ageText.matchAll(/\d+/g)].map((match) => Number(match[0])).filter(Number.isFinite)
  const age = ages.length ? Math.round(ages.reduce((sum, value) => sum + value, 0) / ages.length) : 25
  return `${new Date().getFullYear() - age}-06-15`
}

function codedError(code: string, message: string, retryable: boolean, details: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { generationCode: code, retryable, ...details })
}

function interruptionError(task: ContactGenerationTask): ContactGenerationError {
  return { code: 'APP_INTERRUPTED', stage: task.status, message: '上次生成期间应用被关闭或刷新，请手动继续任务', technicalMessage: 'Persisted task was active when a new app session initialized', retryable: true, attempt: task.attempt, provider: task.provider, model: task.model, occurredAt: Date.now() }
}

function classifyError(error: unknown, task: ContactGenerationTask): ContactGenerationError {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {}
  const technicalMessage = error instanceof Error ? error.message : String(error)
  let code = typeof record.generationCode === 'string' ? record.generationCode : 'GENERATION_FAILED'
  if (error instanceof DOMException && error.name === 'AbortError') code = 'REQUEST_ABORTED'
  else if (/401|api.?key|unauthorized|鉴权|密钥/i.test(technicalMessage)) code = 'AUTH_INVALID'
  else if (/429|rate.?limit|频率|限流/i.test(technicalMessage)) code = 'RATE_LIMITED'
  else if (/timeout|timed out|超时/i.test(technicalMessage)) code = 'NETWORK_TIMEOUT'
  else if (/quota|balance|余额|额度/i.test(technicalMessage)) code = 'QUOTA_EXCEEDED'
  const messages: Record<string, string> = {
    AUTH_MISSING: '还没有配置 API Key', AUTH_INVALID: 'API Key 无效或没有访问权限', RATE_LIMITED: '模型服务请求过于频繁，请稍后重试', NETWORK_TIMEOUT: '连接模型服务超时', QUOTA_EXCEEDED: '模型服务余额或额度不足', PERSONA_PARSE_FAILED: '人物资料格式不完整', PERSONA_EMPTY_OUTPUT: '模型没有返回人物资料', PERSONA_JSON_TRUNCATED: '人物资料在生成中被截断', PERSONA_JSON_INVALID: '模型没有按 JSON 格式返回人物资料', PERSONA_REQUIRED_FIELD_MISSING: '人物资料缺少关键字段', PERSONA_REQUIRED_FIELD_INVALID: '人物资料的关键字段无效', PERSONA_REPAIR_FAILED: '自动修复人物资料后仍未通过校验', WORLDBOOK_CANON_FAILED: '明确选择的世界书正史整理失败', REQUEST_ABORTED: '任务已被中断', GENERATION_FAILED: '联系人生成未能完成', DATABASE_COMMIT_FAILED: '联系人保存失败',
  }
  return {
    code,
    stage: task.status,
    message: messages[code] ?? technicalMessage,
    technicalMessage,
    retryable: typeof record.retryable === 'boolean' ? record.retryable : !['AUTH_MISSING', 'PROMPT_DISABLED'].includes(code),
    attempt: task.attempt,
    provider: task.provider,
    model: task.model,
    httpStatus: typeof record.httpStatus === 'number' ? record.httpStatus : undefined,
    responseChars: typeof record.responseChars === 'number' ? record.responseChars : task.rawOutput?.length,
    failedFields: Array.isArray(record.failedFields) ? record.failedFields.filter((field): field is string => typeof field === 'string') : undefined,
    validation: record.validation && typeof record.validation === 'object' ? record.validation as ContactGenerationError['validation'] : undefined,
    occurredAt: Date.now(),
  }
}
