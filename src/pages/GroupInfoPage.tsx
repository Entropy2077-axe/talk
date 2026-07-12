import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate, useParams } from 'react-router-dom'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { Avatar } from '../components/Avatar'
import { displayName } from '../lib/contact'
import { activeIntents } from '../lib/intent'
import { buildUserProfileText } from '../lib/chatEngine'
import { buildGroupJsonConversionPrompt, buildGroupRawChatPrompt } from '../lib/groupChat'
import { knowledgeDigestText } from '../lib/knowledgeBase'
import { describeCurrentTime } from '../lib/time'
import { isModuleEnabled } from '../features'
import { useSettingsStore } from '../store/useSettingsStore'
import { setGroupPlanStatus } from '../lib/groupPlans'
import type { Contact, Group, GroupEnergyLevel, GroupPlan, GroupSpeakerLimit } from '../types'

const EMPTY_CONTACTS: Contact[] = []
const SPEAKER_LIMIT_OPTIONS: GroupSpeakerLimit[] = [2, 3, 4, 5, 'all']
const ENERGY_OPTIONS: { value: GroupEnergyLevel; label: string; description: string }[] = [
  { value: 'cold', label: '冷淡', description: '每个发言人回一句话' },
  { value: 'normal', label: '普通', description: '每个发言人回2~3句话' },
  { value: 'lively', label: '热闹', description: '每个发言人回4句话以上' },
]

function latestUsedIntents(contact: Contact) {
  return (contact.intentQueue ?? [])
    .filter((intent) => intent.status === 'used')
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 3)
}

function LatestGroupAiTurnJson({ groupId }: { groupId: string }) {
  const latestTurn = useLiveQuery(async () => {
    const conv = await db.conversations.where('groupId').equals(groupId).first()
    if (!conv) return null
    const turns = await db.aiTurns.where('conversationId').equals(conv.id).reverse().sortBy('createdAt')
    return turns[0] ?? null
  }, [groupId])

  if (!latestTurn?.raw) return <p className="text-sm text-gray-400">暂无群聊原始 JSON</p>

  return (
    <pre className="whitespace-pre-wrap break-words rounded-lg bg-gray-50 p-2.5 font-mono text-[10px] leading-relaxed text-gray-600">
      {latestTurn.raw}
    </pre>
  )
}

function AdminIntentList({ members }: { members: Contact[] }) {
  if (members.length === 0) return <p className="text-sm text-gray-400">暂无成员</p>

  return (
    <div className="space-y-3">
      {members.map((member) => {
        const active = activeIntents(member, Date.now(), 10)
        const used = latestUsedIntents(member)
        return (
          <div key={member.id} className="rounded-lg bg-gray-50 px-3 py-2.5">
            <div className="mb-2 flex items-center gap-2">
              <Avatar avatar={member.avatar} color={member.avatarColor} size={28} />
              <p className="text-sm font-medium text-gray-800">{displayName(member)}</p>
            </div>
            <div className="space-y-2 text-xs text-gray-600">
              <div>
                <p className="mb-1 text-[11px] text-gray-400">Active</p>
                {active.length === 0 ? (
                  <p className="text-gray-400">暂无</p>
                ) : (
                  <ul className="space-y-1">
                    {active.map((intent) => (
                      <li key={intent.id} className="rounded-md bg-white px-2 py-1.5">
                        <p>{intent.text}</p>
                        <p className="mt-0.5 text-[10px] text-gray-400">
                          {intent.kind} / {intent.confidence} / {new Date(intent.createdAt).toLocaleString()}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <p className="mb-1 text-[11px] text-gray-400">Used 最近3条</p>
                {used.length === 0 ? (
                  <p className="text-gray-400">暂无</p>
                ) : (
                  <ul className="space-y-1">
                    {used.map((intent) => (
                      <li key={intent.id} className="rounded-md bg-white px-2 py-1.5">
                        <p>{intent.text}</p>
                        <p className="mt-0.5 text-[10px] text-gray-400">
                          {intent.kind} / {intent.confidence} / {new Date(intent.createdAt).toLocaleString()}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function speakerLimitLabel(value: GroupSpeakerLimit) {
  return value === 'all' ? '全部' : String(value)
}

export function GroupInfoPage() {
  const { groupId } = useParams()
  const navigate = useNavigate()
  const settings = useSettingsStore()
  const adminEnabled = useSettingsStore((s) => s.adminModeEnabled)
  const [confirming, setConfirming] = useState(false)
  const [editingMembers, setEditingMembers] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [selectedToAdd, setSelectedToAdd] = useState<string[]>([])

  const group = useLiveQuery(() => (groupId ? db.groups.get(groupId) : undefined), [groupId])
  const groupPlans = useLiveQuery(() => (groupId ? db.groupPlans.where('groupId').equals(groupId).reverse().sortBy('createdAt') : []), [groupId]) ?? []
  const allContacts = useLiveQuery(() => db.contacts.toArray(), []) ?? EMPTY_CONTACTS
  const membersRaw = useLiveQuery(() => (group ? db.contacts.bulkGet(group.memberContactIds) : []), [group])
  const stickers = useLiveQuery(() => db.stickers.toArray(), []) ?? []
  const knowledgeEntries = useLiveQuery(() => db.knowledgeEntries.toArray(), []) ?? []
  const members = useMemo(() => (membersRaw ?? []).filter((c): c is Contact => !!c), [membersRaw])

  const addableContacts = useMemo(() => {
    if (!group) return []
    const memberIds = new Set(group.memberContactIds)
    return allContacts.filter((c) => !memberIds.has(c.id))
  }, [allContacts, group])

  const promptPreviewSpeakers = useMemo(() => {
    if (!group) return []
    const limit = group.speakerLimit ?? 3
    return limit === 'all' ? members : members.slice(0, Math.min(limit, members.length))
  }, [group, members])

  const promptPreview =
    adminEnabled && group && promptPreviewSpeakers.length > 0
      ? buildGroupRawChatPrompt({
          stylePrompt: settings.globalSystemPrompt,
          groupName: group.name,
          allMembers: members,
          speakers: promptPreviewSpeakers,
          stickerNames: stickers.map((s) => s.name),
          groupMemoryText: group.memory,
          groupVibeText: group.vibe,
          allowAiChatter: group.allowAiChatter ?? true,
          energyLevel: group.energyLevel ?? 'normal',
          currentTimeText: describeCurrentTime(new Date()),
          userProfileText: buildUserProfileText(settings),
          targetedContextText: '【预览】这里会放入用户本轮@、回复对象等定向上下文。',
          recentEventsText: '【预览】这里会放入最近朋友圈/群聊等社交事件。',
          worldviewText: isModuleEnabled('worldview') ? '【运行时按群聊内容检索世界书条目；此预览不固定命中结果】' : undefined,
          knowledgeDigestText: isModuleEnabled('knowledgeBase') ? (knowledgeDigestText(knowledgeEntries) || undefined) : undefined,
          selfIterationGlobalText: isModuleEnabled('selfIteration') ? settings.selfIterationGlobalPrompt : undefined,
          speakerMemoriesMap: new Map(),
        })
      : ''

  const conversionPreview =
    adminEnabled && promptPreviewSpeakers.length > 0
      ? buildGroupJsonConversionPrompt('【主模型群聊纯文本草稿会放在这里】', promptPreviewSpeakers, stickers.map((s) => s.name))
      : ''

  function toggleAdd(id: string) {
    setSelectedToAdd((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  async function updateGroup(patch: Partial<Group>) {
    if (!group) return
    await db.groups.update(group.id, patch)
  }

  function openNameEditor() {
    if (!group) return
    setNameDraft(group.name)
    setEditingName(true)
  }

  async function saveName() {
    const next = nameDraft.trim()
    if (!group || !next) return
    await updateGroup({ name: next })
    setEditingName(false)
  }

  async function handleAddMembers() {
    if (!group || selectedToAdd.length === 0) return
    const next = Array.from(new Set([...group.memberContactIds, ...selectedToAdd]))
    await db.groups.update(group.id, { memberContactIds: next })
    setSelectedToAdd([])
  }

  async function handleRemoveMember(contactId: string) {
    if (!group || group.memberContactIds.length <= 1) return
    await db.groups.update(group.id, {
      memberContactIds: group.memberContactIds.filter((id) => id !== contactId),
    })
  }

  async function handleDisband() {
    if (!group) return
    const conv = await db.conversations.where('groupId').equals(group.id).first()
    if (conv) {
      await db.messages.where('conversationId').equals(conv.id).delete()
      await db.conversations.delete(conv.id)
    }
    await db.groups.delete(group.id)
    navigate('/', { replace: true })
  }

  if (group === undefined) return null
  if (group === null || !groupId) {
    return (
      <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
        <TopBar title="群聊" showBack />
        <p className="px-4 py-10 text-center text-sm text-gray-400">该群聊已被解散</p>
      </div>
    )
  }

  return (
    <div className="relative flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
      <TopBar title="群聊信息" showBack />

      <div className="flex-1 overflow-y-auto">
        <section className="mt-3 flex flex-col items-center gap-2 bg-white px-4 py-6">
          <Avatar avatar={group.avatar} color={group.avatarColor} size={64} />
          <button onClick={openNameEditor} className="text-[15px] font-medium text-gray-900 underline-offset-2 active:underline">
            {group.name}
          </button>
          <p className="text-xs text-gray-400">{members.length} 位成员</p>
        </section>

        <section className="mt-3 bg-white">
          <button
            onClick={openNameEditor}
            className="flex w-full items-center justify-between border-b border-gray-100 px-4 py-3.5 text-left active:bg-gray-50"
          >
            <span className="text-[15px] text-gray-900">群聊名称</span>
            <span className="max-w-[58%] truncate text-sm text-gray-400">{group.name}</span>
          </button>
        </section>

        <section className="mt-3 bg-white px-4 py-4">
          <h3 className="mb-2 text-xs font-medium text-gray-400">群聊记忆</h3>
          <p className="whitespace-pre-wrap rounded-lg bg-gray-50 px-3 py-2 text-sm leading-relaxed text-gray-600">
            {group.memory || '暂无群聊记忆。后续可由群聊总结自动沉淀。'}
          </p>
        </section>

        <section className="mt-3 bg-white px-4 py-4">
          <h3 className="mb-2 text-xs font-medium text-gray-400">群聊氛围</h3>
          <p className="whitespace-pre-wrap rounded-lg bg-gray-50 px-3 py-2 text-sm leading-relaxed text-gray-600">
            {group.vibe || '暂无群聊氛围。后续可由群聊总结自动沉淀。'}
          </p>
        </section>

        <section className="mt-3 bg-white px-4 py-4">
          <h3 className="mb-2 text-xs font-medium text-gray-400">朋友圈素材</h3>
          <div className="grid grid-cols-3 gap-2">
            {([
              ['enabled', '允许引用'], ['relationshipOnly', '仅关系'], ['private', '群内私密'],
            ] as const).map(([value, label]) => <button key={value} type="button" onClick={() => void updateGroup({ momentSharing: value })} className={`rounded-lg border px-2 py-2 text-xs ${(group.momentSharing ?? 'enabled') === value ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-200 text-gray-600'}`}>{label}</button>)}
          </div>
        </section>

        <section className="mt-3 bg-white px-4 py-4">
          <h3 className="mb-2 text-xs font-medium text-gray-400">共同计划</h3>
          {groupPlans.length === 0 ? <p className="text-sm text-gray-400">群聊中形成明确约定后，会自动出现在这里。</p> : <div className="space-y-2">{groupPlans.map((plan: GroupPlan) => <div key={plan.id} className="rounded-lg bg-gray-50 p-3"><p className="text-sm font-medium text-gray-900">{plan.title}</p><p className="mt-1 text-xs text-gray-500">{plan.summary}{plan.location ? ` · ${plan.location}` : ''}</p><p className="mt-1 text-[11px] text-gray-400">{plan.status === 'pending' ? '待确认' : plan.status === 'confirmed' ? '已确认' : plan.status === 'completed' ? '已成行' : '已取消'}</p>{plan.status === 'pending' && <div className="mt-2 flex gap-2"><button type="button" onClick={() => void setGroupPlanStatus(plan, group, 'confirmed', settings)} className="rounded-md bg-gray-900 px-2.5 py-1 text-xs text-white">确认成行</button><button type="button" onClick={() => void setGroupPlanStatus(plan, group, 'cancelled', settings)} className="rounded-md bg-white px-2.5 py-1 text-xs text-gray-500">取消</button></div>}{plan.status === 'confirmed' && <div className="mt-2 flex gap-2"><button type="button" onClick={() => void setGroupPlanStatus(plan, group, 'completed', settings)} className="rounded-md bg-green-600 px-2.5 py-1 text-xs text-white">已成行</button><button type="button" onClick={() => void setGroupPlanStatus(plan, group, 'cancelled', settings)} className="rounded-md bg-white px-2.5 py-1 text-xs text-gray-500">取消</button></div>}</div>)}</div>}
        </section>

        <section className="mt-3 bg-white px-4 py-4">
          <h3 className="mb-2 text-xs font-medium text-gray-400">每轮发言人数</h3>
          <div className="grid grid-cols-5 gap-2">
            {SPEAKER_LIMIT_OPTIONS.map((option) => {
              const checked = (group.speakerLimit ?? 3) === option
              return (
                <button
                  key={String(option)}
                  onClick={() => void updateGroup({ speakerLimit: option })}
                  className={`rounded-lg border px-2 py-2 text-sm ${
                    checked ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-200 bg-white text-gray-600'
                  }`}
                >
                  {speakerLimitLabel(option)}
                </button>
              )
            })}
          </div>
        </section>

        <section className="mt-3 bg-white px-4 py-4">
          <h3 className="mb-2 text-xs font-medium text-gray-400">AI是否可以互相聊起来</h3>
          <div className="grid grid-cols-2 gap-2">
            {[
              { label: '可以', value: true, description: '允许接话、吐槽、短暂发展群内互动' },
              { label: '不可以', value: false, description: '只围绕用户和用户相关话题回应' },
            ].map((option) => {
              const checked = (group.allowAiChatter ?? true) === option.value
              return (
                <button
                  key={option.label}
                  onClick={() => void updateGroup({ allowAiChatter: option.value })}
                  className={`rounded-lg border px-3 py-2 text-left ${
                    checked ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-200 bg-white text-gray-600'
                  }`}
                >
                  <span className="block text-sm font-medium">{option.label}</span>
                  <span className={`mt-0.5 block text-[11px] ${checked ? 'text-gray-200' : 'text-gray-400'}`}>
                    {option.description}
                  </span>
                </button>
              )
            })}
          </div>
        </section>

        <section className="mt-3 bg-white px-4 py-4">
          <h3 className="mb-2 text-xs font-medium text-gray-400">群聊热闹程度</h3>
          <div className="grid grid-cols-3 gap-2">
            {ENERGY_OPTIONS.map((option) => {
              const checked = (group.energyLevel ?? 'normal') === option.value
              return (
                <button
                  key={option.value}
                  onClick={() => void updateGroup({ energyLevel: option.value })}
                  className={`rounded-lg border px-3 py-2 text-left ${
                    checked ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-200 bg-white text-gray-600'
                  }`}
                >
                  <span className="block text-sm font-medium">{option.label}</span>
                  <span className={`mt-0.5 block text-[11px] ${checked ? 'text-gray-200' : 'text-gray-400'}`}>
                    {option.description}
                  </span>
                </button>
              )
            })}
          </div>
        </section>

        <section className="mt-3 bg-white px-4 py-4">
          <div className="mb-2 flex items-center justify-between">
            <label className="block text-xs font-medium text-gray-400">群成员</label>
            <button onClick={() => setEditingMembers((v) => !v)} className="text-xs text-gray-500 underline">
              {editingMembers ? '完成' : '管理'}
            </button>
          </div>

          <div className="mb-4 space-y-1">
            {members.map((c) => (
              <div key={c.id} className="flex items-center gap-2 rounded-lg px-2 py-2">
                <button
                  onClick={() => navigate(`/contact/${c.id}`)}
                  className="flex flex-1 items-center gap-3 text-left active:bg-gray-50"
                >
                  <Avatar avatar={c.avatar} color={c.avatarColor} size={36} />
                  <span className="text-sm text-gray-800">{displayName(c)}</span>
                </button>
                {editingMembers && (
                  <button
                    onClick={() => void handleRemoveMember(c.id)}
                    disabled={group.memberContactIds.length <= 1}
                    className="rounded-lg bg-red-50 px-2 py-1 text-xs text-red-500 disabled:opacity-40"
                  >
                    移除
                  </button>
                )}
              </div>
            ))}
          </div>

          {editingMembers && (
            <div className="rounded-lg bg-gray-50 p-3">
              <h3 className="mb-2 text-xs font-medium text-gray-400">添加成员</h3>
              {addableContacts.length === 0 ? (
                <p className="text-sm text-gray-400">没有可添加的联系人</p>
              ) : (
                <div className="space-y-1">
                  {addableContacts.map((c) => {
                    const checked = selectedToAdd.includes(c.id)
                    return (
                      <button
                        key={c.id}
                        onClick={() => toggleAdd(c.id)}
                        className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left active:bg-gray-50"
                      >
                        <div
                          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
                            checked ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-300'
                          }`}
                        >
                          {checked && '✓'}
                        </div>
                        <Avatar avatar={c.avatar} color={c.avatarColor} size={32} />
                        <span className="text-sm text-gray-800">{displayName(c)}</span>
                      </button>
                    )
                  })}
                  <button
                    onClick={() => void handleAddMembers()}
                    disabled={selectedToAdd.length === 0}
                    className="mt-2 w-full rounded-lg bg-gray-900 py-2 text-sm text-white disabled:opacity-40"
                  >
                    添加选中的 {selectedToAdd.length} 人
                  </button>
                </div>
              )}
            </div>
          )}
        </section>

        {adminEnabled && (
          <>
            <section className="mt-3 bg-white px-4 py-4">
              <h3 className="mb-2 text-xs font-medium text-gray-400">各个AI的内部意图</h3>
              <AdminIntentList members={members} />
            </section>

            <section className="mt-3 bg-white px-4 py-4">
              <h3 className="mb-2 text-xs font-medium text-gray-400">最新群聊原始JSON</h3>
              <LatestGroupAiTurnJson groupId={group.id} />
            </section>

            <section className="mt-3 bg-white px-4 py-4">
              <h3 className="mb-2 text-xs font-medium text-gray-400">提示词预览</h3>
              {promptPreview ? (
                <div className="space-y-4">
                  <div className="rounded-lg border-2 border-gray-800">
                    <div className="border-b border-gray-200 bg-gray-100 px-3 py-1.5">
                      <span className="text-xs font-bold text-gray-800">发给主模型（{settings.model}）</span>
                      <span className="ml-2 text-[10px] text-gray-400">群聊纯文本草稿</span>
                    </div>
                    <pre className="whitespace-pre-wrap break-words p-3 font-sans text-[11px] leading-relaxed text-gray-700">
                      {promptPreview}
                    </pre>
                  </div>

                  <div className="rounded-lg border-2 border-gray-800">
                    <div className="border-b border-gray-200 bg-gray-100 px-3 py-1.5">
                      <span className="text-xs font-bold text-gray-800">发给多功能模型（{settings.utilityModel}）</span>
                      <span className="ml-2 text-[10px] text-gray-400">纯文本 → 群聊JSON</span>
                    </div>
                    <pre className="whitespace-pre-wrap break-words p-3 font-sans text-[11px] leading-relaxed text-gray-700">
                      {conversionPreview}
                    </pre>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-gray-400">暂无可预览的成员</p>
              )}
            </section>
          </>
        )}

        <section className="mt-3 bg-white px-4 py-4">
          {confirming ? (
            <div className="rounded-lg bg-red-50 p-3">
              <p className="mb-2 text-xs text-red-500">解散后聊天记录也会一起删除，无法恢复。确定吗？</p>
              <div className="flex gap-2">
                <button onClick={() => setConfirming(false)} className="flex-1 rounded-lg bg-gray-100 py-2 text-xs text-gray-600">
                  取消
                </button>
                <button onClick={handleDisband} className="flex-1 rounded-lg bg-red-500 py-2 text-xs text-white">
                  确认解散
                </button>
              </div>
            </div>
          ) : (
            <button onClick={() => setConfirming(true)} className="w-full rounded-lg bg-red-50 py-2.5 text-sm text-red-500">
              解散群聊
            </button>
          )}
        </section>
      </div>

      {editingName && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/30 p-8">
          <div className="w-full rounded-2xl bg-white p-4">
            <h2 className="mb-3 text-center text-[15px] font-medium text-gray-900">修改群聊名称</h2>
            <input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              placeholder="群聊名称"
              maxLength={24}
              className="mb-4 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
            />
            <div className="flex gap-2">
              <button
                onClick={() => {
                  setNameDraft(group.name)
                  setEditingName(false)
                }}
                className="flex-1 rounded-lg bg-gray-100 py-2 text-sm text-gray-600"
              >
                取消
              </button>
              <button
                onClick={() => void saveName()}
                disabled={!nameDraft.trim()}
                className="flex-1 rounded-lg bg-gray-900 py-2 text-sm text-white disabled:opacity-40"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
