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
import { pruneExpiredOverrides, describeCurrentSchedule, describeUpcomingScheduleText } from '../lib/schedule'
import { WEEKDAYS, describeCurrentTime } from '../lib/time'
import { RELATIONSHIP_OPTIONS, AVAILABLE_LINK_APPS, buildSystemPromptSections } from '../lib/prompt'
import { warmthLabel, warmthPrompt } from '../lib/relationship'
import { buildUserProfileText } from '../lib/chatEngine'
import { knowledgeDigestText } from '../lib/knowledgeBase'
import { useSettingsStore } from '../store/useSettingsStore'

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

  const contact = useLiveQuery(() => (contactId ? db.contacts.get(contactId) : undefined), [contactId])
  const conversation = useLiveQuery(
    () => (contactId ? db.conversations.where('contactId').equals(contactId).first() : undefined),
    [contactId],
  )
  const stickers = useLiveQuery(() => db.stickers.toArray(), []) ?? []
  const knowledgeEntries = useLiveQuery(() => db.knowledgeEntries.toArray(), []) ?? []
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
  const hasMemory = contact.memoryFacts || contact.memoryStyle || activePlans.length > 0
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
  const promptSections = settings.adminModeEnabled
    ? buildSystemPromptSections({
        stylePrompt: settings.globalSystemPrompt,
        persona: contact.systemPrompt,
        relationshipBase: contact.relationshipBase || '朋友',
        relationshipDynamic: contact.relationshipDynamic || '',
        warmth: contact.warmth ?? 0,
        warmthPrompt: warmthPrompt(contact.warmth ?? 0),
        memoryFacts: contact.memoryFacts,
        memoryStyle: contact.memoryStyle,
        stickerNames: stickers.map((s) => s.name),
        linkApps: AVAILABLE_LINK_APPS,
        currentTimeText: describeCurrentTime(now),
        userProfileText: buildUserProfileText(settings),
        recentEventsText: pendingEvents.length > 0 ? pendingEvents.join('；') : undefined,
        upcomingPlansText: activeUpcomingPlansText(contact, now) || undefined,
        currentScheduleText: describeCurrentSchedule(contact, now) || undefined,
        upcomingScheduleText: describeUpcomingScheduleText(contact, now) || undefined,
        worldviewText: settings.worldview || undefined,
        knowledgeDigestText: knowledgeDigestText(knowledgeEntries) || undefined,
      })
    : []

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
          className="flex w-full items-center justify-between px-4 py-3.5 text-left active:bg-gray-50"
        >
          <span className="text-[15px] text-gray-900">关系定位</span>
          <span className="text-sm text-gray-400">{contact.relationshipBase || '未设置'}</span>
        </button>
      </div>
      <p className="mt-1.5 px-4 text-[11px] text-gray-400">
        好感度: {contact.warmth ?? 0}（{warmthLabel(contact.warmth ?? 0)}）{contact.relationshipDynamic ? ` · ${contact.relationshipDynamic}` : ''}
      </p>

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
          </div>
        ) : (
          <p className="text-sm text-gray-400">还没有形成记忆 多聊几句之后会自己记住一些关于你的事</p>
        )}
      </section>

      <section className="mt-3 bg-white px-4 py-4">
        <h3 className="mb-2 text-xs font-medium text-gray-400">日程（自动生成，仅展示）</h3>
        {schedule.length === 0 ? (
          <p className="text-sm text-gray-400">暂无日程安排</p>
        ) : (
          <div className="space-y-1.5">
            {WEEKDAYS.map((label, day) => {
              const blocks = [...schedule].filter((b) => b.dayOfWeek === day).sort((a, b) => a.startHour - b.startHour)
              if (blocks.length === 0) return null
              return (
                <p key={day} className="text-sm leading-relaxed text-gray-600">
                  <span className="font-medium text-gray-800">{label} </span>
                  {blocks
                    .map(
                      (b) =>
                        `${b.startHour}-${b.endHour}点 ${b.activity}(${b.location})${
                          b.phoneAccess === 'unavailable' ? ' 📴' : ''
                        }`,
                    )
                    .join('、')}
                </p>
              )
            })}
          </div>
        )}
        {activeOverrides.length > 0 && (
          <div className="mt-3 border-t border-gray-100 pt-3">
            <h4 className="mb-1 text-xs font-medium text-gray-400">近期例外安排</h4>
            {activeOverrides.map((o) => (
              <p key={o.id} className="text-sm text-gray-600">
                [{o.date}] {o.summary}
              </p>
            ))}
          </div>
        )}
      </section>

      {settings.adminModeEnabled && (
        <section className="mt-3 bg-white px-4 py-4">
          <h3 className="mb-2 text-xs font-medium text-gray-400">当前系统提示词（管理员模式，按类别分开）</h3>
          <div className="space-y-3">
            {promptSections.map((s) => (
              <div key={s.label} className="rounded-lg bg-gray-50 p-2.5">
                <h4 className="mb-1 text-xs font-medium text-gray-500">{s.label}</h4>
                <pre className="whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-gray-700">
                  {s.content}
                </pre>
              </div>
            ))}
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
