import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate, useParams } from 'react-router-dom'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { isAiTestId } from '../lib/aiTestIsolation'
import { TopBar } from '../components/TopBar'
import { Avatar } from '../components/Avatar'
import { AvatarPicker } from '../components/AvatarPicker'
import { ActionSheet } from '../components/ActionSheet'
import { SchedulePlanner } from '../components/SchedulePlanner'
import { displayName } from '../lib/contact'
import { activeUpcomingPlans, activeUpcomingPlansText, resetMemory } from '../lib/memory'
import { cascadeDeleteContactSocialData } from '../lib/moments'
import { removeContactFromAllGroups } from '../lib/groupChat'
import { describeCurrentSchedule, describeUpcomingScheduleText, isPhoneAvailable, scheduleOccurrencesForDate } from '../lib/schedule'
import { normalizeMood } from '../lib/mood'
import { ageFromBirthday, describeCurrentTime } from '../lib/time'
import { RELATIONSHIP_OPTIONS, buildRawChatPromptParts } from '../lib/prompt'
import { useModuleEnabled, isModuleEnabled } from '../features'
import { warmthLabel, relationshipLine } from '../lib/relationship'
import { buildUserProfileText } from '../lib/chatEngine'
import { useSettingsStore } from '../store/useSettingsStore'
import type { Contact, ContactMemoryScope, ContactRelationLabel, ScheduleBlock, ScheduleOverride } from '../types'
import { CONTACT_RELATION_LABELS } from '../types'
import { removePairedContactRelation, setPairedContactRelation, uniqueRelationPairs } from '../lib/contactRelations'
import { chatCompletionText as chatCompletion } from '../lib/deepseek'
import { buildOccupationPrompt, parseOccupation, employmentPatch, OCCUPATION_OPTIONS } from '../lib/career'
import { formatCurrency } from '../lib/wallet'
import { setWalletBalance } from '../lib/finance'
import { promptModulesForContact } from '../lib/promptPresets'
import { featureActive } from '../lib/promptModules'
import { contactSpeechVoice, isSpeechProviderReady, speechProviderName, speechVoiceOptions } from '../lib/speechProviders'
import { synthesizeSpeech } from '../lib/speechSynthesis'
import { isImageProviderReady, isStickerProviderReady } from '../lib/mediaProviders'
import { privateTurnToolDefinition } from '../lib/chatAgentTools'
import { ArrowUpFromLine, ChevronLeft, ChevronRight, ClipboardList, Phone, PhoneOff } from 'lucide-react'

const CALENDAR_HOUR_HEIGHT = 22

function startOfMonday(date: Date) {
  const value = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  value.setDate(value.getDate() - ((value.getDay() + 6) % 7))
  return value
}

function sameLocalDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function calendarTaskTone(task: { activity: string; location: string }, special: boolean) {
  if (special) return 'special'
  const text = `${task.activity} ${task.location}`
  if (/睡觉|休息|午休|补觉/.test(text)) return 'rest'
  if (/上班|工作|会议|开会|汇报|课程|上课|公司|办公室|学校|教室/.test(text)) return 'work'
  return 'personal'
}

function adaptiveCalendarTitleSize(activity: string, durationMs: number) {
  const chars = Math.max(activity.trim().length, 1)
  const area = 34 * Math.max(durationMs / 3_600_000 * CALENDAR_HOUR_HEIGHT - 8, 12)
  return Math.max(8, Math.min(16, Math.floor(Math.sqrt(area / (chars * 1.25)))))
}

type ScheduleEditTarget = { kind: 'default'; task: ScheduleBlock } | { kind: 'special'; task: ScheduleOverride }

function ScheduleWeekTimeline({ contact, onEdit, onOptimize, optimizing, optimizeError }: { contact: Contact; onEdit: (target: ScheduleEditTarget) => void; onOptimize: () => void; optimizing: boolean; optimizeError: string }) {
  void onEdit; void onOptimize; void optimizing; void optimizeError
  const [weekStart, setWeekStart] = useState(() => startOfMonday(new Date()))
  const [now, setNow] = useState(() => new Date())
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => {
    const date = new Date(weekStart)
    date.setDate(weekStart.getDate() + index)
    return date
  }), [weekStart])
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const monthTitle = `${weekStart.getMonth() + 1}月 · 第${Math.ceil((weekStart.getDate() + ((new Date(weekStart.getFullYear(), weekStart.getMonth(), 1).getDay() + 6) % 7)) / 7)}周`
  const weekdayLabels = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

  return <section className="mt-3 bg-white px-4 py-4">
    <div className="mb-2 flex items-center justify-between">
      <h3 className="text-xs font-medium text-gray-400">日程表</h3>
      <div className="flex items-center gap-1 text-xs text-gray-600">
        <button type="button" aria-label="上一周" onClick={() => setWeekStart((value) => new Date(value.getFullYear(), value.getMonth(), value.getDate() - 7))} className="flex h-7 w-7 items-center justify-center rounded-md border border-gray-200"><ChevronLeft size={16} /></button>
        <span className="min-w-20 text-center font-medium">{monthTitle}</span>
        <button type="button" aria-label="下一周" onClick={() => setWeekStart((value) => new Date(value.getFullYear(), value.getMonth(), value.getDate() + 7))} className="flex h-7 w-7 items-center justify-center rounded-md border border-gray-200"><ChevronRight size={16} /></button>
      </div>
    </div>
    <div ref={scrollRef} className="schedule-week-scroll" aria-label="本周日程时间轴">
      <div className="schedule-week-header">
        <span />
        {days.map((day, index) => <span key={day.getTime()} className={sameLocalDay(day, today) ? 'schedule-week-today' : ''}>{weekdayLabels[index]}<b>{day.getDate()}</b></span>)}
      </div>
      <div className="schedule-week-body">
        <div className="schedule-week-hours">{Array.from({ length: 25 }, (_, hour) => <span key={hour} style={{ top: hour * CALENDAR_HOUR_HEIGHT }}>{hour === 24 ? '23:59' : `${String(hour).padStart(2, '0')}:00`}</span>)}</div>
        {days.map((day) => {
          const occurrences = scheduleOccurrencesForDate(contact, day)
          const isToday = sameLocalDay(day, today)
          return <div key={day.getTime()} className="schedule-week-day">
            {occurrences.map((occurrence) => {
              const duration = occurrence.endsAt - occurrence.startsAt
              const active = now.getTime() >= occurrence.startsAt && now.getTime() < occurrence.endsAt
              const task = occurrence.task
              const tone = active ? 'current' : calendarTaskTone(task, occurrence.kind === 'special')
              return <div key={occurrence.id} data-ui-scope="special" className={`schedule-week-event schedule-week-event--${tone}`} style={{ top: (new Date(occurrence.startsAt).getHours() * 60 + new Date(occurrence.startsAt).getMinutes()) / 60 * CALENDAR_HOUR_HEIGHT + 1, height: Math.max(duration / 3_600_000 * CALENDAR_HOUR_HEIGHT - 2, 9) }} aria-label={`${task.activity}，${task.phoneAccess === 'available' ? '可以接电话' : '不方便接电话'}`}>
                {duration >= 40 * 60_000 && <span className="schedule-week-event-title" style={{ fontSize: adaptiveCalendarTitleSize(task.activity, duration) }}>{task.activity}</span>}
                {duration >= 20 * 60_000 && <span className="schedule-week-event-phone">{task.phoneAccess === 'available' ? <Phone size={11} /> : <PhoneOff size={11} />}</span>}
              </div>
            })}
            {isToday && <span className="schedule-week-now" style={{ top: (now.getHours() * 60 + now.getMinutes()) / 60 * CALENDAR_HOUR_HEIGHT }}><i /></span>}
          </div>
        })}
      </div>
    </div>
    <div className="schedule-week-legend" data-ui-scope="special">
      <span><i className="schedule-week-swatch schedule-week-swatch--work" />绿色：工作/学习</span><span><i className="schedule-week-swatch schedule-week-swatch--personal" />紫色：个人安排</span><span><i className="schedule-week-swatch schedule-week-swatch--rest" />蓝灰：休息</span><span><i className="schedule-week-swatch schedule-week-swatch--special" />金色：特殊安排</span><span><i className="schedule-week-swatch schedule-week-swatch--current" />红色：当前进行中</span>
    </div>
  </section>
}

function LatestAiTurnJson({ contactId }: { contactId: string }) {
  const latestTurn = useLiveQuery(async () => {
    const conv = await db.conversations.where('contactId').equals(contactId).first()
    if (!conv) return null
    const turns = await db.aiTurns.where('conversationId').equals(conv.id).reverse().sortBy('createdAt')
    return turns[0] ?? null
  }, [contactId])

  if (!latestTurn?.raw) return null
  const actionCommittee = latestTurn.parsed && typeof latestTurn.parsed === 'object'
    ? (latestTurn.parsed as Record<string, unknown>).actionCommittee
    : undefined
  return (
    <section className="mt-3 bg-white px-4 py-4">
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-gray-400"><ClipboardList size={14} />最新AI原始JSON</h3>
      <pre className="whitespace-pre-wrap break-words rounded-lg bg-gray-50 p-2.5 font-mono text-[10px] leading-relaxed text-gray-600">
        {latestTurn.raw}
      </pre>
      {actionCommittee !== undefined && <>
        <h4 className="mb-2 mt-3 text-xs font-medium text-gray-400">行动委员会</h4>
        <pre className="whitespace-pre-wrap break-words rounded-lg bg-gray-50 p-2.5 font-mono text-[10px] leading-relaxed text-gray-600">{JSON.stringify(actionCommittee, null, 2)}</pre>
      </>}
    </section>
  )
}

const MEMORY_SCOPE_LABELS: Record<ContactMemoryScope, string> = {
  private: '个人结构化记忆',
  group: '群聊记忆',
  interpersonal: '与其他人的记忆',
}

export function ContactCardPage() {
  void ScheduleWeekTimeline
  const { contactId } = useParams()
  const navigate = useNavigate()
  const settings = useSettingsStore()
  const immersiveMode = settings.experienceMode === 'immersive'
  const [menuOpen, setMenuOpen] = useState(false)
  const [editingRemark, setEditingRemark] = useState(false)
  const [remarkDraft, setRemarkDraft] = useState('')
  const [clearMemoryConfirm, setClearMemoryConfirm] = useState(false)
  const [pickingAvatar, setPickingAvatar] = useState(false)
  const [pickingRelationshipType, setPickingRelationshipType] = useState(false)
  const relEnabled = useModuleEnabled('relationship')
  const adminEnabled = useSettingsStore((s) => s.adminModeEnabled)
  const moodEnabled = true
  const careerEnabled = useModuleEnabled('career')
  const [assigningCareer, setAssigningCareer] = useState(false)
  const [editingRelations, setEditingRelations] = useState(false)
  const [testingSpeechVoice, setTestingSpeechVoice] = useState(false)
  const [speechVoiceStatus, setSpeechVoiceStatus] = useState('')
  const [relationDrafts, setRelationDrafts] = useState<Array<{ targetContactId: string; label: string }>>([])

  const contact = useLiveQuery(() => (contactId ? db.contacts.get(contactId) : undefined), [contactId])
  const currentLocation = useLiveQuery(() => contact?.currentLocationId ? db.locations.get(contact.currentLocationId) : undefined, [contact?.currentLocationId])
  const allLocations = useLiveQuery(() => db.locations.toArray(), []) ?? []
  const allContacts = (useLiveQuery(() => db.contacts.toArray(), []) ?? []).filter((item) => !isAiTestId(item.id))
  const conversation = useLiveQuery(
    () => (contactId ? db.conversations.where('contactId').equals(contactId).first() : undefined),
    [contactId],
  )

  const contactWallet = useLiveQuery(() => contactId ? db.walletAccounts.get(contactId) : undefined, [contactId])
  const momentCount = useLiveQuery(() => contactId ? db.moments.where('contactId').equals(contactId).count() : 0, [contactId]) ?? 0
  const socialTimeline = useLiveQuery(async () => {
    if (!contactId) return []
    return (await db.socialEvents.orderBy('createdAt').reverse().limit(80).toArray())
      .filter((event) => event.relatedContactIds.includes(contactId) || event.actorId === contactId || event.targetId === contactId)
      .slice(0, 6)
  }, [contactId]) ?? []
  const structuredMemories = useLiveQuery(
    () => (contactId ? db.contactMemories.where('contactId').equals(contactId).reverse().sortBy('updatedAt') : []),
    [contactId],
  ) ?? []
  const relationLinks = useLiveQuery(
    async () => {
      if (!contactId) return []
      const links = await db.contactRelations
        .filter((link) => link.fromContactId === contactId || link.toContactId === contactId)
        .toArray()
      const otherIds = Array.from(new Set(links.map((link) => (link.fromContactId === contactId ? link.toContactId : link.fromContactId))))
      const contacts = await db.contacts.bulkGet(otherIds)
      const contactById = new Map(contacts.filter((c): c is NonNullable<typeof c> => !!c).map((c) => [c.id, c]))
      return uniqueRelationPairs(links)
        .map((link) => {
          const otherId = link.fromContactId === contactId ? link.toContactId : link.fromContactId
          const other = contactById.get(otherId)
          return other ? { id: link.id, targetContactId: otherId, name: displayName(other), label: link.label } : null
        })
        .filter((item): item is { id: string; targetContactId: string; name: string; label: ContactRelationLabel } => !!item)
    },
    [contactId],
  ) ?? []
  const structuredMemoryGroups = structuredMemories.reduce(
    (acc, memory) => {
      const scope = memory.scope ?? 'private'
      acc[scope].push(memory)
      return acc
    },
    { private: [], group: [], interpersonal: [] } as Record<ContactMemoryScope, typeof structuredMemories>,
  )
  async function assignCareer() {
    if (!contact || !settings.apiKey) return
    const value = window.prompt(`输入职业（例如：${OCCUPATION_OPTIONS.slice(0,6).join('、')}）`, contact.occupation ?? '')?.trim()
    if (!value) return
    setAssigningCareer(true)
    try {
      const careerPrompt = buildOccupationPrompt(value, contact.systemPrompt, settings)
      if (!careerPrompt.trim()) throw new Error('职业提示词模块已屏蔽')
      const raw = await chatCompletion({ apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.utilityModel, messages: [{ role: 'system', content: careerPrompt }, { role: 'user', content: '生成职业资料' }], jsonMode: true, purpose: 'persona' })
      const parsed = parseOccupation(raw)
      if (!parsed) throw new Error('职业资料生成失败')
      await db.contacts.update(contact.id, { ...employmentPatch(value, parsed.monthlySalary), ...(parsed.schedule ? { schedule: parsed.schedule } : {}) })
    } finally { setAssigningCareer(false) }
  }
  const stickers = useLiveQuery(() => db.stickers.toArray(), []) ?? []
  if (contact === undefined) return null
  if (contact === null || !contactId) {
    return (
      <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
        <TopBar title="联系人" showBack />
        <p className="px-4 py-10 text-center text-sm text-gray-400">该联系人已被删除</p>
      </div>
    )
  }

  async function handleChat() {
    let conv = conversation
    if (!conv) {
      const now = Date.now()
      conv = { id: uuid(), contactId: contactId!, pinned: false, createdAt: now, updatedAt: now }
      await db.conversations.add(conv)
    }
    void navigate(`/chat/${conv.id}`)
  }

  const activeSpeechProvider = settings.speechProvider
  const activeSpeechVoice = contactSpeechVoice(contact, activeSpeechProvider)
  const activeSpeechOptions = speechVoiceOptions(settings)

  async function saveSpeechVoice(voiceId: string) {
    if (!contact || activeSpeechProvider === 'none') return
    const previous = contact.speechVoices?.[activeSpeechProvider]
    await db.contacts.update(contact.id, {
      speechVoices: {
        ...contact.speechVoices,
        [activeSpeechProvider]: {
          voiceId,
          styleInstruction: previous?.styleInstruction,
          source: 'user',
          assignedAt: Date.now(),
        },
      },
    })
    setSpeechVoiceStatus('已保存，这位联系人之后会使用该音色')
  }

  async function saveSpeechStyle(styleInstruction: string) {
    if (!contact || activeSpeechProvider === 'none' || !activeSpeechVoice) return
    await db.contacts.update(contact.id, {
      speechVoices: {
        ...contact.speechVoices,
        [activeSpeechProvider]: { ...activeSpeechVoice, styleInstruction: styleInstruction.trim(), source: 'user', assignedAt: Date.now() },
      },
    })
    setSpeechVoiceStatus('声音演绎方式已保存')
  }

  async function testSpeechVoice() {
    if (!contact || !activeSpeechVoice) return
    setTestingSpeechVoice(true)
    setSpeechVoiceStatus('正在生成试听…')
    try {
      const result = await synthesizeSpeech(`你好，我是${displayName(contact)}。`, settings, activeSpeechVoice)
      const url = URL.createObjectURL(result.blob)
      const audio = new Audio(url)
      audio.addEventListener('ended', () => URL.revokeObjectURL(url), { once: true })
      await audio.play()
      setSpeechVoiceStatus('试听生成成功')
    } catch (error) {
      setSpeechVoiceStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setTestingSpeechVoice(false)
    }
  }

  async function handleDelete() {
    if (conversation) {
      await db.messages.where('conversationId').equals(conversation.id).delete()
      await db.mediaAssets.where('conversationId').equals(conversation.id).delete()
      await db.conversations.delete(conversation.id)
    }
    await cascadeDeleteContactSocialData(contactId!)
    await removeContactFromAllGroups(contactId!)
    await db.contacts.delete(contactId!)
    await db.worldContactStates.where('contactId').equals(contactId!).delete()
    void navigate('/contacts', { replace: true })
  }

  function openRelationEditor() {
    setRelationDrafts(relationLinks.map((link) => ({ targetContactId: link.targetContactId, label: link.label })))
    setEditingRelations(true)
  }

  async function saveRelationEditor() {
    if (!contactId) return
    const drafts = relationDrafts
      .map((draft) => ({ targetContactId: draft.targetContactId, label: draft.label.trim() }))
      .filter((draft, index, all) => draft.targetContactId && draft.label && all.findIndex((item) => item.targetContactId === draft.targetContactId) === index)
    const oldLinks = await db.contactRelations.filter((link) => link.fromContactId === contactId || link.toContactId === contactId).toArray()
    const oldTargetIds = new Set(oldLinks.map((link) => link.fromContactId === contactId ? link.toContactId : link.fromContactId))
    for (const targetId of oldTargetIds) await removePairedContactRelation(contactId, targetId)
    for (const draft of drafts) await setPairedContactRelation(contactId, draft.targetContactId, draft.label as ContactRelationLabel)
    setEditingRelations(false)
  }

  async function saveRemark() {
    await db.contacts.update(contactId!, { remark: remarkDraft.trim() })
    setEditingRemark(false)
  }

  const contactNow = Date.now()
  const activePlans = activeUpcomingPlans(contact.upcomingPlans ?? [], new Date(contactNow))
  const hasMemory = contact.memoryFacts || contact.memoryStyle || activePlans.length > 0 || structuredMemories.length > 0 || relationLinks.length > 0

  // Admin-mode-only: shows exactly what would be sent as the system prompt
  // right now, for debugging persona/relationship issues. Mirrors
  // chatEngine.ts's runAiTurn data-gathering, but must NOT replicate its
  // pendingEvents-clearing side effect — this is a read-only preview, not
  // an actual turn, so pendingEvents here is read straight off the live
  // contact instead of going through the "read once then clear" flow.
  const now = new Date(contactNow)
  const pendingEvents = contact.pendingEvents ?? []
  // ---- admin-mode preview of the next native-tool request ----
  const previewPromptModules = promptModulesForContact(contact, settings)
  const previewPromptSettings = { ...settings, promptModules: previewPromptModules }
  const mainModelPromptParts = adminEnabled
    ? buildRawChatPromptParts({
        name: contact.name,
        persona: [
          contact.systemPrompt,
          contact.birthday && ageFromBirthday(contact.birthday) !== null ? `【当前年龄硬事实】生日为${contact.birthday}，当前${ageFromBirthday(contact.birthday)}岁。` : '',
          careerEnabled && contact.occupation ? `当前职业：${contact.occupation}，现实月薪：${contact.monthlySalary ?? 0}。` : '',
        ].filter(Boolean).join('\n\n'),
        stylePrompt: settings.globalSystemPrompt,
        promptModules: previewPromptModules,
        worldviewText: isModuleEnabled('worldview') ? '【运行时按当前对话检索世界书条目；此预览不固定命中结果】' : undefined,
        latestUserText: '【预览】这里会放入用户本轮最新消息',
        recentContext: '',
        relationshipContext: `【你和对方的关系】${relationshipLine(
            relEnabled ? (contact.relationshipBase || '朋友') : '朋友',
            relEnabled ? (contact.relationshipDynamic || '') : '',
            relEnabled ? (contact.warmth ?? 0) : 0,
          )}`,
        memoryContext: [
          `【你对TA的了解】${contact.memoryFacts || '（刚开始聊）'}`,
          `【相处习惯】${contact.memoryStyle || '（还没有形成习惯）'}`,
        ].join('\n\n'),
        situationContext:
          `【当前情境】现在: ${describeCurrentTime(now)}。对方: ${buildUserProfileText(settings)}。${contact.mood?.text ? `你的心情: ${contact.mood.text}。` : ''}【日程】${describeCurrentSchedule(contact, now) ? `\n当前: ${describeCurrentSchedule(contact, now)}` : '\n当前: 暂无安排'}${describeUpcomingScheduleText(contact, now) ? `\n接下来:\n${describeUpcomingScheduleText(contact, now)}` : '\n接下来: 暂无安排'}${activeUpcomingPlansText(contact, now) ? `\n约定: ${activeUpcomingPlansText(contact, now)}` : ''}${pendingEvents.length > 0 ? `\n最近: ${pendingEvents.join('；')}` : ''}\n\n【运行时动态内容】实际发送时还会加入本轮检索到的结构化记忆、AI关系、近期跨场景原文、地点合法列表、离线记忆补全、最近聊天历史、联系人推荐去重名单和重生成指令；这些内容依赖本轮消息，预览不会伪造固定结果。`,
        stickerNames: stickers.map((s) => s.name),
        remoteStickerSearchEnabled: isStickerProviderReady(settings),
        imageGenerationEnabled: isImageProviderReady(settings),
        imageSearchEnabled: !!settings.pexelsApiKey,
      })
    : null
  const privateToolPreview = adminEnabled
    ? privateTurnToolDefinition({
        stickerNames: stickers.map((sticker) => sticker.name),
        stickerSearchEnabled: isStickerProviderReady(settings),
        imageEnabled: isImageProviderReady(settings) || !!settings.pexelsApiKey,
        knowledgeEnabled: featureActive(previewPromptSettings, 'knowledgeBase'),
        scheduleEnabled: isModuleEnabled('location'),
        locationIds: allLocations.filter((location) => !allLocations.some((candidate) => candidate.parentId === location.id)).map((location) => location.id),
      })
    : null

  return (
    <div className="relative flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
      <TopBar title="联系人名片" showBack />
      <div className="flex flex-1 flex-col overflow-y-auto">

      <section className="mx-3 mt-3 rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] px-5 py-6 shadow-[var(--ui-shadow)]">
        <div className="flex items-center gap-4"><button type="button" onClick={() => setPickingAvatar(true)} aria-label="修改头像"><Avatar avatar={contact.avatar} color={contact.avatarColor} size={72} /></button><div className="min-w-0 flex-1"><h2 className="ui-font-display truncate text-xl font-semibold text-[var(--ui-text)]">{displayName(contact)}</h2><p className="mt-0.5 truncate text-xs text-[var(--ui-text-3)]">{contact.remark ? `备注：${contact.remark}` : `本名：${contact.name}`}</p>{contact.relationshipBase && <span className="mt-2 inline-block rounded-full bg-[var(--ui-accent-soft)] px-2.5 py-1 text-[11px] text-[var(--ui-action)]">{contact.relationshipBase}{contact.relationshipDynamic ? ` · ${contact.relationshipDynamic}` : ''}</span>}</div></div>
        {contact.avatarPhotographer && <p className="mt-3 text-[11px] text-[var(--ui-text-3)]">头像照片来自 Pexels · {contact.avatarPhotographerUrl ? <a href={contact.avatarPhotographerUrl} target="_blank" rel="noreferrer" className="underline">{contact.avatarPhotographer}</a> : contact.avatarPhotographer}</p>}
        {adminEnabled && <button type="button" onClick={() => navigate(`/contact/${contactId}/admin`)} className="mt-4 w-full rounded-lg bg-gray-900 px-3 py-2.5 text-sm font-medium text-white">编辑全部资料</button>}
        <div className="mt-5 grid grid-cols-3 gap-2"><button type="button" onClick={handleChat} className="rounded-[var(--ui-radius-control)] bg-[var(--ui-action)] py-2.5 text-xs font-medium text-[var(--ui-on-action)]">发消息</button><button type="button" onClick={() => navigate(`/moments?contact=${contactId}`)} className="rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-2)] py-2.5 text-xs text-[var(--ui-text-2)]">朋友圈（{momentCount}）</button><button type="button" onClick={() => setMenuOpen(true)} className="rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-2)] py-2.5 text-xs text-[var(--ui-text-2)]">管理联系人</button></div>
      </section>

      <section className="mx-3 mt-3 rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] px-4 py-4 shadow-[var(--ui-shadow)]">
        <h3 className="mb-3 text-xs font-medium text-[var(--ui-text-3)]">此刻的 TA</h3>
        <div className="grid grid-cols-2 gap-2 text-sm"><div className="rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-2)] px-3 py-2.5"><p className="text-[11px] text-[var(--ui-text-3)]">状态</p><p className="mt-1 text-[var(--ui-text-2)]">{isPhoneAvailable(contact, new Date(contactNow)) ? '可联系' : '暂时不便联系'} · {describeCurrentSchedule(contact, new Date(contactNow)).replace(/^现在在/, '') || '空闲'}</p></div>{moodEnabled && <div className="rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-2)] px-3 py-2.5"><p className="text-[11px] text-[var(--ui-text-3)]">心情</p><p className="mt-1 text-[var(--ui-text-2)]">{contact.mood?.text && contactNow < contact.mood.expiresAt ? normalizeMood(contact.mood.text) : '暂无'}</p></div>}{currentLocation && <div className="rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-2)] px-3 py-2.5"><p className="text-[11px] text-[var(--ui-text-3)]">当前位置</p><p className="mt-1 text-[var(--ui-text-2)]">{currentLocation.name}</p></div>}{!immersiveMode && relEnabled && <div className="rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-2)] px-3 py-2.5"><p className="text-[11px] text-[var(--ui-text-3)]">好感度</p><p className="mt-1 text-[var(--ui-text-2)]">{contact.warmth !== undefined ? `${contact.warmth} · ${warmthLabel(contact.warmth)}` : '未评估'}</p></div>}</div>
      </section>

      <section className="mx-3 mt-4 rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] px-4 py-4 shadow-[var(--ui-shadow)]">
        <div className="mb-2 flex items-center justify-between"><h3 className="text-xs font-medium text-[var(--ui-text-3)]">关系与资料</h3><button type="button" onClick={() => { setRemarkDraft(contact.remark ?? ''); setEditingRemark(true) }} className="text-xs text-[var(--ui-special-ink)]">修改备注</button></div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 border-b border-[var(--ui-border)] pb-3 text-xs text-[var(--ui-text-3)]"><p>性别：{contact.gender || contact.creatorProfile?.gender || '未填写'}</p><p>真名：{contact.realName || contact.name}</p><p>网名：{contact.nickname || contact.name}</p><p>生日：{contact.birthday || '未填写'}</p></div>
        <div className="mt-1"><button type="button" onClick={() => setPickingRelationshipType(true)} className="flex w-full items-center justify-between py-3 text-left active:opacity-70"><span className="text-[15px] text-[var(--ui-text)]">关系定位</span><span className="text-sm text-[var(--ui-text-3)]">{contact.relationshipBase || '未设置'}</span></button>{careerEnabled && <button type="button" onClick={immersiveMode ? undefined : assignCareer} disabled={assigningCareer} className="flex w-full items-center justify-between border-t border-[var(--ui-border)] py-3 text-left disabled:opacity-50"><span className="text-[15px] text-[var(--ui-text)]">职业</span><span className="text-sm text-[var(--ui-text-3)]">{immersiveMode ? contact.occupation || '暂时不了解' : assigningCareer ? '生成中…' : contact.occupation ? `${contact.occupation} · 月薪 ${formatCurrency(contact.monthlySalary ?? 0, settings)}` : '赋予职业'}</span></button>}{!immersiveMode && careerEnabled && <button type="button" onClick={adminEnabled ? async () => { const raw = prompt('设定该AI的钱包余额', String(contactWallet?.balance ?? 0)); if (raw !== null && Number.isFinite(Number(raw)) && Number(raw) >= 0) await setWalletBalance(contact.id, Number(raw)) } : undefined} className="flex w-full items-center justify-between border-t border-[var(--ui-border)] py-3 text-left"><span className="text-[15px] text-[var(--ui-text)]">钱包</span><span className="text-sm text-[var(--ui-text-3)]">{formatCurrency(contactWallet?.balance ?? 0, settings)}{adminEnabled ? ' · 点击设定' : ''}</span></button>}</div>
      </section>

      <SchedulePlanner contact={contact} settings={settings} memories={structuredMemories} />


      {!immersiveMode && <section className="mx-3 mt-4 rounded-[var(--ui-radius-card)] bg-white px-4 py-4 shadow-[var(--ui-shadow)]">
        <h3 className="mb-2 text-xs font-medium text-gray-400">最近社交动态</h3>
        {socialTimeline.length === 0 ? <p className="text-sm text-gray-400">暂时还没有公开互动。</p> : <div className="space-y-2">{socialTimeline.map((event) => <button key={event.id} type="button" onClick={() => event.groupId ? navigate(`/group/${event.groupId}`) : event.momentId ? navigate(`/moments?focus=${event.momentId}`) : event.conversationId ? navigate(`/chat/${event.conversationId}`) : undefined} className="block w-full border-l-2 border-[var(--ui-success)] pl-2 text-left"><p className="text-sm text-gray-700">{event.summary}</p><p className="mt-0.5 text-[10px] text-gray-400">{new Date(event.createdAt).toLocaleString()}</p></button>)}</div>}
      </section>}

      {!immersiveMode && <section className="mx-3 mt-4 rounded-[var(--ui-radius-card)] bg-white px-4 py-4 shadow-[var(--ui-shadow)]">
        <div className="mb-2 flex items-center justify-between">
          <div><h3 className="text-xs font-medium text-gray-400">AI之间的关系</h3><p className="mt-1 text-[11px] text-gray-400">关系会影响朋友圈点赞、评论和群聊互动，可随时自定义。</p></div>
          <button type="button" onClick={openRelationEditor} className="text-xs text-[var(--ui-special-ink)]">编辑关系</button>
        </div>
        {relationLinks.length === 0 ? <p className="text-sm text-gray-400">还没有设置与其他联系人的关系</p> : <div className="space-y-1.5">{relationLinks.map((link) => <div key={link.id} className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2 text-sm"><span>{link.name}</span><span className="text-xs text-gray-500">{link.label}</span></div>)}</div>}
      </section>}

      <section className="mx-3 mt-4 rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] px-4 py-4 shadow-[var(--ui-shadow)]">
        <div className="flex items-start justify-between gap-3"><div><h3 className="text-xs font-medium text-[var(--ui-text-3)]">联系人语音</h3><p className="mt-1 text-[11px] leading-relaxed text-[var(--ui-text-3)]">音色只属于这位联系人，不会套用到其他人。</p></div><span className="shrink-0 text-xs text-[var(--ui-text-2)]">{speechProviderName(activeSpeechProvider)}</span></div>
        {activeSpeechProvider === 'none' || !isSpeechProviderReady(settings) ? <button type="button" onClick={() => navigate('/settings/speech-generation')} className="mt-3 w-full rounded-[var(--ui-radius-control)] border border-dashed border-[var(--ui-border)] px-3 py-3 text-sm text-[var(--ui-text-2)]">先配置语音生成服务</button> : <div className="mt-3 space-y-3">{!activeSpeechVoice && <p className="rounded-[var(--ui-radius-control)] bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700">暂时没有对号入座。请选择一个音色，否则聊天里生成语音时会提醒回来设置。</p>}<label className="block text-xs text-[var(--ui-text-2)]">音色<select value={activeSpeechVoice?.voiceId ?? ''} onChange={(event) => void saveSpeechVoice(event.target.value)} className="mt-1 w-full rounded-[var(--ui-radius-control)] border border-[var(--ui-border)] bg-[var(--ui-surface)] px-3 py-2.5 text-sm text-[var(--ui-text)]"><option value="" disabled>请选择适合这位联系人的音色</option>{activeSpeechOptions.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>{activeSpeechProvider === 'mimo' && activeSpeechVoice && <label className="block text-xs text-[var(--ui-text-2)]">声音演绎方式<textarea defaultValue={activeSpeechVoice.styleInstruction ?? ''} onBlur={(event) => void saveSpeechStyle(event.target.value)} placeholder="例如：低沉克制、语速稍慢，熟悉后更温柔" rows={2} className="mt-1 w-full resize-none rounded-[var(--ui-radius-control)] border border-[var(--ui-border)] px-3 py-2 text-sm text-[var(--ui-text)] outline-none" /></label>}{activeSpeechVoice && <button type="button" disabled={testingSpeechVoice} onClick={() => void testSpeechVoice()} className="w-full rounded-[var(--ui-radius-control)] bg-[var(--ui-action)] py-2.5 text-sm text-[var(--ui-on-action)] disabled:opacity-50">{testingSpeechVoice ? '生成试听中…' : '试听这位联系人的声音'}</button>}{speechVoiceStatus && <p className="text-xs leading-5 text-[var(--ui-text-2)]">{speechVoiceStatus}</p>}</div>}
      </section>

      <section className="mx-3 mt-4 rounded-[var(--ui-radius-card)] bg-white px-4 py-4 shadow-[var(--ui-shadow)]">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-medium text-gray-400">AI记忆（随聊天自动积累）</h3>
          {hasMemory && (
            <button onClick={() => setClearMemoryConfirm(true)} className="text-xs text-gray-400 underline">
              清空记忆
            </button>
          )}
        </div>
        {hasMemory ? (
          <div className="space-y-2 text-sm leading-relaxed text-gray-600">
            <p>
              <span className="text-xs text-gray-400">了解到的信息 </span>
              {contact.memoryFacts || '暂无'}
            </p>
            <p>
              <span className="text-xs text-gray-400">相处状态 </span>
              {contact.memoryStyle || '暂无'}
            </p>
            {activePlans.length > 0 && (
              <div>
                <span className="text-xs text-gray-400">和你的约定 </span>
                <ul className="mt-1 space-y-0.5">
                  {activePlans.map((p) => (
                    <li key={p.id}>{p.date ? `[${p.date}] ${p.text}` : p.text}</li>
                  ))}
                </ul>
              </div>
            )}
            {relationLinks.length > 0 && (
              <div>
                <span className="text-xs text-gray-400">已知朋友关系 </span>
                <ul className="mt-1 space-y-0.5">
                  {relationLinks.map((link) => (
                    <li key={link.id}>{link.name} 是TA的{link.label}</li>
                  ))}
                </ul>
              </div>
            )}
            {(['private', 'group', 'interpersonal'] as ContactMemoryScope[]).map((scope) => {
              const memories = structuredMemoryGroups[scope].slice(0, 8)
              if (memories.length === 0) return null
              return (
                <div key={scope}>
                  <span className="text-xs text-gray-400">{MEMORY_SCOPE_LABELS[scope]} </span>
                  <ul className="mt-1 space-y-1">
                    {memories.map((memory) => (
                      <li key={memory.id} className="rounded-lg bg-gray-50 px-2.5 py-1.5">
                        <p>{memory.content}</p>
                        {memory.tags.length > 0 && (
                          <p className="mt-0.5 text-[11px] text-gray-400">
                            {memory.tags.slice(0, 4).map((tag) => `#${tag}`).join(' ')}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="text-sm text-gray-400">还没有形成记忆 多聊几句之后会自己记住一些关于你的事</p>
        )}
      </section>


      {adminEnabled && (
        <LatestAiTurnJson contactId={contactId!} />
      )}

      {adminEnabled && (
        <section className="mx-3 mt-4 rounded-[var(--ui-radius-card)] bg-white px-4 py-4 shadow-[var(--ui-shadow)]">
          <div className="mb-3"><h3 className="text-xs font-medium text-gray-400">下一轮私聊请求预览（管理员模式）</h3><p className="mt-1 text-[10px] text-gray-400">包含系统提示词和同次请求携带的原生工具协议。运行时记忆、聊天历史与检索结果会随本轮消息变化。来源：{contact.promptPresetSourceName || '升级前提示词'}{contact.promptSnapshotUpdatedAt ? ` · ${new Date(contact.promptSnapshotUpdatedAt).toLocaleString()}` : ''}</p></div>

          <div className="space-y-4">
            {/* System prompt sent with the native tool schema below. */}
            <div className="rounded-lg border-2 border-gray-800">
              <div className="border-b border-gray-200 bg-gray-100 px-3 py-1.5">
                <span className="flex items-center gap-1.5 text-xs font-bold text-gray-800"><ArrowUpFromLine size={14} />{`发给主模型（${settings.model}）`}</span>
                <span className="ml-2 text-[10px] text-gray-400">系统提示词；回复通过下方原生工具提交</span>
              </div>
              <div className="p-3">
                <div className="space-y-3">
                  <div className="rounded-lg border border-gray-200 bg-white">
                    <div className="border-b border-gray-100 px-3 py-2">
                      <p className="text-xs font-bold text-gray-900">逻辑</p>
                      <p className="mt-0.5 text-[10px] text-gray-400">身份、记忆、地点、日程、心情、关系等硬前提，优先级最高</p>
                    </div>
                    <pre className="whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-gray-700">
                      {mainModelPromptParts?.logic}
                    </pre>
                  </div>

                  <div className="rounded-lg border border-gray-200 bg-gray-50">
                    <div className="border-b border-gray-100 px-3 py-2">
                      <p className="text-xs font-bold text-gray-700">感觉</p>
                      <p className="mt-0.5 text-[10px] text-gray-400">在逻辑正确后再优化文笔、节奏、情绪和聊天感</p>
                    </div>
                    <pre className="whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-gray-600">
                      {mainModelPromptParts?.feeling}
                    </pre>
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-lg border-2 border-gray-800">
              <div className="border-b border-gray-200 bg-gray-100 px-3 py-1.5">
                <span className="flex items-center gap-1.5 text-xs font-bold text-gray-800">原生工具协议（同一次模型请求）</span>
                <span className="ml-2 text-[10px] text-gray-400">模型必须通过 submit_turn 提交实际消息与行动</span>
              </div>
              <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-gray-700">
                {JSON.stringify(privateToolPreview, null, 2)}
              </pre>
            </div>

          </div>
        </section>
      )}

      </div>

      {menuOpen && (
        <ActionSheet
          onClose={() => setMenuOpen(false)}
          options={[{ label: '确认删除该联系人及聊天记录', onSelect: handleDelete, danger: true }]}
        />
      )}
      {editingRelations && (
        <div className="absolute inset-0 z-40 flex items-end bg-black/40" onClick={() => setEditingRelations(false)}>
          <div className="max-h-[86%] w-full overflow-y-auto rounded-t-2xl bg-white p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]" onClick={(event) => event.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between"><div><h3 className="text-base font-medium text-gray-900">编辑 AI 关系</h3><p className="mt-1 text-[11px] text-gray-400">自定义关系会同步写入双方，并立即影响朋友圈互动。</p></div><button type="button" onClick={() => setEditingRelations(false)} className="text-sm text-gray-500">关闭</button></div>
            <div className="space-y-2">
              {relationDrafts.map((draft, index) => (
                <div key={`${draft.targetContactId}-${index}`} className="flex items-center gap-2">
                  <select value={draft.targetContactId} onChange={(event) => setRelationDrafts((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, targetContactId: event.target.value } : row))} className="min-w-0 flex-1 rounded-lg border border-gray-200 px-2 py-2 text-xs">
                    <option value="">选择联系人</option>
                    {allContacts.filter((candidate) => candidate.id !== contactId).map((candidate) => <option key={candidate.id} value={candidate.id}>{displayName(candidate)}</option>)}
                  </select>
                  <input value={draft.label} onChange={(event) => setRelationDrafts((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, label: event.target.value } : row))} list={`relation-labels-${index}`} placeholder="自定义关系" className="min-w-0 flex-1 rounded-lg border border-gray-200 px-2 py-2 text-xs" />
                  <datalist id={`relation-labels-${index}`}>{CONTACT_RELATION_LABELS.map((label) => <option key={label} value={label} />)}</datalist>
                  <button type="button" onClick={() => setRelationDrafts((rows) => rows.filter((_, rowIndex) => rowIndex !== index))} className="shrink-0 text-xs text-red-500">删除</button>
                </div>
              ))}
              <button type="button" onClick={() => { const candidate = allContacts.find((item) => item.id !== contactId && !relationDrafts.some((draft) => draft.targetContactId === item.id)); if (candidate) setRelationDrafts((rows) => [...rows, { targetContactId: candidate.id, label: CONTACT_RELATION_LABELS[0] }]) }} className="text-xs text-[var(--ui-special-ink)]">+ 添加关系</button>
            </div>
            <button type="button" onClick={() => void saveRelationEditor()} className="mt-4 w-full rounded-xl bg-gray-900 py-2.5 text-sm text-white">保存关系</button>
          </div>
        </div>
      )}

      {pickingRelationshipType && (
        <ActionSheet
          onClose={() => setPickingRelationshipType(false)}
          options={[...RELATIONSHIP_OPTIONS.map((label) => ({
            label,
            onSelect: () => { void db.contacts.update(contactId!, { relationshipBase: label }) },
          })), { label: '自定义…', onSelect: () => { const value = window.prompt('输入自定义关系定位', contact.relationshipBase || '')?.trim(); if (value) void db.contacts.update(contactId!, { relationshipBase: value }) } }]}
        />
      )}

      {clearMemoryConfirm && (
        <ActionSheet
          onClose={() => setClearMemoryConfirm(false)}
          options={[
            {
              label: '确认清空对方对你的记忆',
              onSelect: () => resetMemory(contactId!),
              danger: true,
            },
          ]}
        />
      )}

      {pickingAvatar && (
        <AvatarPicker
          onSelect={(avatar, photographer) =>
            db.contacts.update(contactId!, {
              avatar,
              avatarPhotographer: photographer?.name,
              avatarPhotographerUrl: photographer?.url,
            })
          }
          onClose={() => setPickingAvatar(false)}
          settings={settings}
          subject={contact}
        />
      )}

      {editingRemark && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/30 p-8">
          <div className="w-full rounded-2xl bg-white p-4">
            <h2 className="mb-3 text-center text-[15px] font-medium text-gray-900">设置备注</h2>
            <input
              value={remarkDraft}
              onChange={(e) => setRemarkDraft(e.target.value)}
              placeholder="给TA起个只有你看得到的称呼"
              maxLength={20}
              className="mb-4 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
            />
            <div className="flex gap-2">
              <button
                onClick={() => setEditingRemark(false)}
                className="flex-1 rounded-lg bg-gray-100 py-2 text-sm text-gray-600"
              >
                取消
              </button>
              <button onClick={saveRemark} className="flex-1 rounded-lg bg-gray-900 py-2 text-sm text-white">
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
