import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate, useParams } from 'react-router-dom'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { Avatar } from '../components/Avatar'
import { AvatarPicker } from '../components/AvatarPicker'
import { ActionSheet } from '../components/ActionSheet'
import { displayName } from '../lib/contact'
import { activeUpcomingPlans, activeUpcomingPlansText, resetMemory } from '../lib/memory'
import { cascadeDeleteContactSocialData } from '../lib/moments'
import { removeContactFromAllGroups } from '../lib/groupChat'
import { pruneExpiredOverrides, describeCurrentSchedule, describeUpcomingScheduleText, isPhoneAvailable } from '../lib/schedule'
import { WEEKDAYS, describeCurrentTime } from '../lib/time'
import { RELATIONSHIP_OPTIONS, formatSpeechSamplesForScene, buildRawChatPromptParts, buildJsonConversionPrompt } from '../lib/prompt'
import { useModuleEnabled, isModuleEnabled } from '../features'
import { personalityIntimacyStage, warmthLabel, relationshipLine } from '../lib/relationship'
import { buildUserProfileText } from '../lib/chatEngine'
import { useSettingsStore } from '../store/useSettingsStore'
import type { ContactMemoryScope, ContactRelationLabel } from '../types'
import { PERSONALITY_TRAIT_OPTIONS } from '../types'
import { activeIntentPrompt, activeIntents, clearIntentQueue } from '../lib/intent'
import { uniqueRelationPairs } from '../lib/contactRelations'
import { chatCompletion } from '../lib/deepseek'
import { buildOccupationPrompt, parseOccupation, employmentPatch, OCCUPATION_OPTIONS } from '../lib/career'
import { formatCurrency } from '../lib/wallet'
import { setWalletBalance } from '../lib/finance'

function LatestAiTurnJson({ contactId }: { contactId: string }) {
  const latestTurn = useLiveQuery(async () => {
    const conv = await db.conversations.where('contactId').equals(contactId).first()
    if (!conv) return null
    const turns = await db.aiTurns.where('conversationId').equals(conv.id).reverse().sortBy('createdAt')
    return turns[0] ?? null
  }, [contactId])

  if (!latestTurn?.raw) return null
  return (
    <section className="mt-3 bg-white px-4 py-4">
      <h3 className="mb-2 text-xs font-medium text-gray-400">📋 最新AI原始JSON</h3>
      <pre className="whitespace-pre-wrap break-words rounded-lg bg-gray-50 p-2.5 font-mono text-[10px] leading-relaxed text-gray-600">
        {latestTurn.raw}
      </pre>
    </section>
  )
}

const MEMORY_SCOPE_LABELS: Record<ContactMemoryScope, string> = {
  private: '个人结构化记忆',
  group: '群聊记忆',
  interpersonal: '与其他人的记忆',
}

export function ContactCardPage() {
  const { contactId } = useParams()
  const navigate = useNavigate()
  const settings = useSettingsStore()
  const [menuOpen, setMenuOpen] = useState(false)
  const [editingRemark, setEditingRemark] = useState(false)
  const [remarkDraft, setRemarkDraft] = useState('')
  const [clearMemoryConfirm, setClearMemoryConfirm] = useState(false)
  const [pickingAvatar, setPickingAvatar] = useState(false)
  const [pickingRelationshipType, setPickingRelationshipType] = useState(false)
  const [pickingPersonalityTrait, setPickingPersonalityTrait] = useState(false)
  const relEnabled = useModuleEnabled('relationship')
  const personalityEnabled = useModuleEnabled('personalityTraits')
  const adminEnabled = useSettingsStore((s) => s.adminModeEnabled)
  const moodEnabled = useModuleEnabled('mood')
  const careerEnabled = useModuleEnabled('career')
  const [assigningCareer, setAssigningCareer] = useState(false)

  const contact = useLiveQuery(() => (contactId ? db.contacts.get(contactId) : undefined), [contactId])
  const conversation = useLiveQuery(
    () => (contactId ? db.conversations.where('contactId').equals(contactId).first() : undefined),
    [contactId],
  )
  const contactWallet = useLiveQuery(() => contactId ? db.walletAccounts.get(contactId) : undefined, [contactId])
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
          return other ? { id: link.id, name: displayName(other), label: link.label } : null
        })
        .filter((item): item is { id: string; name: string; label: ContactRelationLabel } => !!item)
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
      const raw = await chatCompletion({ apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.utilityModel, messages: [{ role: 'system', content: buildOccupationPrompt(value, contact.systemPrompt) }, { role: 'user', content: '生成职业资料' }], jsonMode: true })
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
    navigate(`/chat/${conv.id}`)
  }

  async function handleDelete() {
    if (conversation) {
      await db.messages.where('conversationId').equals(conversation.id).delete()
      await db.conversations.delete(conversation.id)
    }
    await cascadeDeleteContactSocialData(contactId!)
    await removeContactFromAllGroups(contactId!)
    await db.contacts.delete(contactId!)
    navigate('/contacts', { replace: true })
  }

  async function saveRemark() {
    await db.contacts.update(contactId!, { remark: remarkDraft.trim() })
    setEditingRemark(false)
  }

  const activePlans = activeUpcomingPlans(contact.upcomingPlans ?? [], new Date())
  const visibleActiveIntents = activeIntents(contact, Date.now(), 10)
  const usedIntents = (contact.intentQueue ?? [])
    .filter((intent) => intent.status === 'used')
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 5)
  const hasMemory = contact.memoryFacts || contact.memoryStyle || activePlans.length > 0 || structuredMemories.length > 0 || relationLinks.length > 0
  const schedule = contact.schedule ?? []
  const activeOverrides = pruneExpiredOverrides(contact.scheduleOverrides ?? [], new Date())

  // Admin-mode-only: shows exactly what would be sent as the system prompt
  // right now, for debugging persona/relationship issues. Mirrors
  // chatEngine.ts's runAiTurn data-gathering, but must NOT replicate its
  // pendingEvents-clearing side effect — this is a read-only preview, not
  // an actual turn, so pendingEvents here is read straight off the live
  // contact instead of going through the "read once then clear" flow.
  const now = new Date()
  const pendingEvents = contact.pendingEvents ?? []
  const previewActiveIntents = isModuleEnabled('intent') ? activeIntents(contact, now.getTime()) : []
  // ---- admin-mode prompt preview (two-step pipeline) ----
  const mainModelPromptParts = adminEnabled
    ? buildRawChatPromptParts({
        name: contact.name,
        persona: contact.systemPrompt,
        personaConstraints: contact.personaConstraints,
        personaProfile: contact.personaProfile,
        stylePrompt: settings.globalSystemPrompt,
        selfIterationGlobalText: isModuleEnabled('selfIteration') ? settings.selfIterationGlobalPrompt : undefined,
        selfIterationContactText: isModuleEnabled('selfIteration') ? contact.selfIterationPrompt : undefined,
        personalityTrait: personalityEnabled ? contact.personalityTrait : undefined,
        personalityWarmth: relEnabled ? (contact.warmth ?? 0) : undefined,
        worldviewText: isModuleEnabled('worldview') ? (settings.worldview || undefined) : undefined,
        latestUserText: '【预览】这里会放入用户本轮最新消息',
        recentContext: [
          `【你和对方的关系】${relationshipLine(
            relEnabled ? (contact.relationshipBase || '朋友') : '朋友',
            relEnabled ? (contact.relationshipDynamic || '') : '',
            relEnabled ? (contact.warmth ?? 0) : 0,
          )}`,
          `【你对TA的了解】${contact.memoryFacts || '（刚开始聊）'}`,
          `【相处习惯】${contact.memoryStyle || '（还没有形成习惯）'}`,
          `【当前情境】现在: ${describeCurrentTime(now)}。对方: ${buildUserProfileText(settings)}。${contact.mood?.text ? `你的心情: ${contact.mood.text}。` : ''}【日程】${describeCurrentSchedule(contact, now) ? `\n当前: ${describeCurrentSchedule(contact, now)}` : '\n当前: 暂无安排'}${describeUpcomingScheduleText(contact, now) ? `\n接下来:\n${describeUpcomingScheduleText(contact, now)}` : '\n接下来: 暂无安排'}${activeUpcomingPlansText(contact, now) ? `\n约定: ${activeUpcomingPlansText(contact, now)}` : ''}${pendingEvents.length > 0 ? `\n最近: ${pendingEvents.join('；')}` : ''}`,
        ].filter(Boolean).join('\n\n'),
        activeIntentText: activeIntentPrompt(previewActiveIntents),
        stickerNames: stickers.map((s) => s.name),
        mbti: contact.mbti || undefined,
        speechSamplesText: formatSpeechSamplesForScene(contact.speechSamples, 'private', 3) || undefined,
      })
    : null
  const conversionPrompt = adminEnabled
    ? buildJsonConversionPrompt('【AI的原始回复文字会放在这里】')
    : ''

  return (
    <div className="relative flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
      <TopBar title="联系人名片" showBack />
      <div className="flex-1 overflow-y-auto">

      <section className="mt-3 flex flex-col items-center gap-1 bg-white px-4 py-8">
        <button onClick={() => setPickingAvatar(true)}>
          <Avatar avatar={contact.avatar} color={contact.avatarColor} size={80} />
        </button>
        <h2 className="mt-1 text-lg font-medium text-gray-900">{displayName(contact)}</h2>
        {contact.remark && <p className="text-xs text-gray-400">本名 {contact.name}</p>}
        {contact.avatarPhotographer && (
          <p className="text-[11px] text-gray-300">
            头像照片来自 Pexels ·{' '}
            {contact.avatarPhotographerUrl ? (
              <a href={contact.avatarPhotographerUrl} target="_blank" rel="noreferrer" className="underline">
                {contact.avatarPhotographer}
              </a>
            ) : (
              contact.avatarPhotographer
            )}
          </p>
        )}
      </section>

      <div className="mt-3 bg-white">
        <button
          onClick={() => {
            setRemarkDraft(contact.remark ?? '')
            setEditingRemark(true)
          }}
          className="flex w-full items-center justify-between border-b border-gray-100 px-4 py-3.5 text-left active:bg-gray-50"
        >
          <span className="text-[15px] text-gray-900">备注</span>
          <span className="text-sm text-gray-400">{contact.remark || '未设置'}</span>
        </button>
        <button
          onClick={() => setPickingRelationshipType(true)}
          className="flex w-full items-center justify-between border-b border-gray-100 px-4 py-3.5 text-left active:bg-gray-50"
        >
          <span className="text-[15px] text-gray-900">关系定位</span>
          <span className="text-sm text-gray-400">{contact.relationshipBase || '未设置'}</span>
        </button>
        {personalityEnabled && (
          <button
            onClick={() => setPickingPersonalityTrait(true)}
            className="flex w-full items-center justify-between px-4 py-3.5 text-left active:bg-gray-50"
          >
            <span className="text-[15px] text-gray-900">性格特质</span>
            <span className="text-right text-sm text-gray-400">{contact.personalityTrait || '无'}{contact.personalityTrait && contact.personalityTrait !== '无' && relEnabled ? ` · ${personalityIntimacyStage(contact.warmth ?? 0)}` : ''}</span>
          </button>
        )}
        {moodEnabled && (
          <div className="flex w-full items-center justify-between px-4 py-3.5">
            <span className="text-[15px] text-gray-900">心情</span>
            <span className="text-sm text-gray-400">
              {contact.mood?.text && Date.now() < contact.mood.expiresAt ? contact.mood.text : '暂无'}
            </span>
          </div>
        )}
        <div className="flex w-full items-center justify-between px-4 py-3.5">
          <span className="text-[15px] text-gray-900">状态</span>
          <span className="text-sm text-gray-400">
            {isPhoneAvailable(contact, new Date())
              ? '📱 可聊天 · 可发朋友圈'
              : '📵 正在忙 · 暂不可联系'}
          </span>
        </div>
        {relEnabled && (
          <div className="flex w-full items-center justify-between px-4 py-3.5">
            <span className="text-[15px] text-gray-900">好感度</span>
            <span className="text-sm text-gray-400">
              {contact.warmth !== undefined
                ? `${contact.warmth}（${warmthLabel(contact.warmth)}）${contact.relationshipDynamic ? ` · ${contact.relationshipDynamic}` : ''}`
                : '未评估（下次聊天时自动评估）'}
            </span>
          </div>
        )}
        {careerEnabled && <button onClick={assignCareer} disabled={assigningCareer} className="flex w-full items-center justify-between px-4 py-3.5 text-left active:bg-gray-50 disabled:opacity-50"><span className="text-[15px] text-gray-900">职业</span><span className="text-sm text-gray-400">{assigningCareer?'生成中…':contact.occupation?`${contact.occupation} · 月薪 ${formatCurrency(contact.monthlySalary??0,settings)}`:'赋予职业'}</span></button>}
        {careerEnabled && <button onClick={adminEnabled ? async()=>{const raw=prompt('设定该AI的钱包余额',String(contactWallet?.balance??0));if(raw!==null&&Number.isFinite(Number(raw))&&Number(raw)>=0)await setWalletBalance(contact.id,Number(raw))}:undefined} className="flex w-full items-center justify-between px-4 py-3.5 text-left"><span className="text-[15px] text-gray-900">钱包</span><span className="text-sm text-gray-400">{formatCurrency(contactWallet?.balance??0,settings)}{adminEnabled?' · 点击设定':''}</span></button>}
      </div>

      <section className="mt-3 bg-white px-4 py-4">
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

      <section className="mt-3 bg-white px-4 py-4">
        <h3 className="mb-2 text-xs font-medium text-gray-400">日程</h3>
        {schedule.length === 0 ? (
          <p className="text-sm text-gray-400">暂无日程安排</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr>
                  <th className="py-1 pr-1 text-left text-gray-400 font-normal"></th>
                  {WEEKDAYS.map((label) => (
                    <th key={label} className="px-0.5 py-1 text-center font-medium text-gray-500">{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  { range: '上午', start: 6, end: 12 },
                  { range: '下午', start: 12, end: 18 },
                  { range: '晚上', start: 18, end: 24 },
                ].map(({ range, start, end }) => (
                  <tr key={range}>
                    <td className="py-0.5 pr-1 text-gray-400">{range}</td>
                    {[0, 1, 2, 3, 4, 5, 6].map((day) => {
                      const blocks = schedule
                        .filter((b) => b.dayOfWeek === day && b.startHour < end && b.endHour > start)
                        .sort((a, b) => a.startHour - b.startHour)
                      if (blocks.length === 0) return <td key={day} className="px-0.5 py-0.5 text-center text-gray-300">—</td>
                      const b = blocks[0]
                      return (
                        <td key={day} className="px-0.5 py-0.5 text-center">
                          <span className={b.phoneAccess === 'unavailable' ? 'text-red-400' : 'text-green-500'}>
                            {b.phoneAccess === 'unavailable' ? '📵' : '📱'}
                          </span>
                          <div className="text-[10px] text-gray-600 leading-tight">{b.activity}</div>
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {activeOverrides.length > 0 && (
          <div className="mt-3 border-t border-gray-100 pt-3">
            <h4 className="mb-1 text-xs font-medium text-gray-400">例外安排</h4>
            {activeOverrides.map((o) => (
              <p key={o.id} className="text-sm text-gray-600">
                [{o.date}] {o.summary}
              </p>
            ))}
          </div>
        )}
      </section>

      {adminEnabled && (
        <section className="mt-3 bg-white px-4 py-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-medium text-gray-400">AI 内部意图</h3>
            {(contact.intentQueue ?? []).length > 0 && (
              <button onClick={() => clearIntentQueue(contactId!)} className="text-xs text-gray-400 underline">
                清空内部意图
              </button>
            )}
          </div>

          <div className="space-y-3 text-sm text-gray-600">
            <div>
              <p className="mb-1 text-xs text-gray-400">Active</p>
              {visibleActiveIntents.length === 0 ? (
                <p className="text-gray-400">暂无</p>
              ) : (
                <ul className="space-y-1">
                  {visibleActiveIntents.map((intent) => (
                    <li key={intent.id} className="rounded-lg bg-gray-50 px-2.5 py-2">
                      <p>{intent.text}</p>
                      <p className="mt-0.5 text-[11px] text-gray-400">
                        {intent.kind} / {intent.confidence} / {new Date(intent.createdAt).toLocaleString()}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <p className="mb-1 text-xs text-gray-400">Used 最近 5 条</p>
              {usedIntents.length === 0 ? (
                <p className="text-gray-400">暂无</p>
              ) : (
                <ul className="space-y-1">
                  {usedIntents.map((intent) => (
                    <li key={intent.id} className="rounded-lg bg-gray-50 px-2.5 py-2">
                      <p>{intent.text}</p>
                      <p className="mt-0.5 text-[11px] text-gray-400">
                        {intent.kind} / {intent.confidence} / {new Date(intent.createdAt).toLocaleString()}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>
      )}

      {adminEnabled && (
        <LatestAiTurnJson contactId={contactId!} />
      )}

      {adminEnabled && (
        <section className="mt-3 bg-white px-4 py-4">
          <h3 className="mb-2 text-xs font-medium text-gray-400">提示词预览（管理员模式）</h3>

          <div className="space-y-4">
            {/* Step 1: main model */}
            <div className="rounded-lg border-2 border-gray-800">
              <div className="border-b border-gray-200 bg-gray-100 px-3 py-1.5">
                <span className="text-xs font-bold text-gray-800">{`📤 发给主模型（${settings.model}）`}</span>
                <span className="ml-2 text-[10px] text-gray-400">生成自然语言回复 + 括号想法</span>
              </div>
              <div className="p-3">
                <div className="space-y-3">
                  <div className="rounded-lg border border-gray-200 bg-white">
                    <div className="border-b border-gray-100 px-3 py-2">
                      <p className="text-xs font-bold text-gray-900">逻辑</p>
                      <p className="mt-0.5 text-[10px] text-gray-400">身份、记忆、地点、日程、心情、关系等硬前提，优先级最高</p>
                    </div>
                    <pre className="whitespace-pre-wrap break-words p-3 font-sans text-[11px] leading-relaxed text-gray-700">
                      {mainModelPromptParts?.logic}
                    </pre>
                  </div>

                  <div className="rounded-lg border border-gray-200 bg-gray-50">
                    <div className="border-b border-gray-100 px-3 py-2">
                      <p className="text-xs font-bold text-gray-700">感觉</p>
                      <p className="mt-0.5 text-[10px] text-gray-400">在逻辑正确后再优化文笔、节奏、情绪和聊天感</p>
                    </div>
                    <pre className="whitespace-pre-wrap break-words p-3 font-sans text-[11px] leading-relaxed text-gray-600">
                      {mainModelPromptParts?.feeling}
                    </pre>
                  </div>
                </div>
              </div>
            </div>

            {/* Step 2: utility model */}
            <div className="rounded-lg border-2 border-gray-800">
              <div className="border-b border-gray-200 bg-gray-100 px-3 py-1.5">
                <span className="text-xs font-bold text-gray-800">{`📥 发给多功能模型（${settings.utilityModel}）`}</span>
                <span className="ml-2 text-[10px] text-gray-400">原始文字 → JSON（提取mood/thought/表情包）</span>
              </div>
              <div className="p-3">
                <pre className="whitespace-pre-wrap break-words font-sans text-[11px] leading-relaxed text-gray-700">
                  {conversionPrompt}
                </pre>
              </div>
            </div>
          </div>
        </section>
      )}

      <div className="mt-3 flex flex-col gap-2 bg-white px-4 py-4">
        <button onClick={handleChat} className="w-full rounded-lg bg-gray-900 py-2.5 text-sm text-white">
          发消息
        </button>
        <button onClick={() => setMenuOpen(true)} className="w-full rounded-lg bg-gray-100 py-2.5 text-sm text-red-500">
          删除联系人
        </button>
      </div>
      </div>

      {menuOpen && (
        <ActionSheet
          onClose={() => setMenuOpen(false)}
          options={[{ label: '确认删除该联系人及聊天记录', onSelect: handleDelete, danger: true }]}
        />
      )}

      {pickingRelationshipType && (
        <ActionSheet
          onClose={() => setPickingRelationshipType(false)}
          options={RELATIONSHIP_OPTIONS.map((label) => ({
            label,
            onSelect: () => db.contacts.update(contactId!, { relationshipBase: label }),
          }))}
        />
      )}

      {pickingPersonalityTrait && (
        <ActionSheet
          onClose={() => setPickingPersonalityTrait(false)}
          options={PERSONALITY_TRAIT_OPTIONS.map((opt) => ({
            label: opt.value,
            onSelect: () => db.contacts.update(contactId!, { personalityTrait: opt.value }),
          }))}
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
          pexelsApiKey={settings.pexelsApiKey}
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
