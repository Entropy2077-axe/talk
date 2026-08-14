import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate, useParams } from 'react-router-dom'
import { db } from '../db/db'
import { isAiTestId } from '../lib/aiTestIsolation'
import { TopBar } from '../components/TopBar'
import { Avatar } from '../components/Avatar'
import { displayName } from '../lib/contact'
import { activeIntents } from '../lib/intent'
import { buildUserProfileText } from '../lib/chatEngine'
import { buildGroupJsonConversionPrompt, buildGroupRawChatPrompt, buildLocationRawChatPrompt } from '../lib/groupChat'
import { describeCurrentTime } from '../lib/time'
import { isModuleEnabled } from '../features'
import { useSettingsStore } from '../store/useSettingsStore'
import { setGroupPlanStatus } from '../lib/groupPlans'
import type { Contact, Group, GroupEnergyLevel, GroupPlan, GroupSpeakerLimit } from '../types'
import { realSeason, resolveLocationParticipants, syncContactLocationsAt } from '../lib/locations'

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
              <p className="ui-font-display text-sm font-medium text-gray-800">{displayName(member)}</p>
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
  const groupLocation = useLiveQuery(() => (group?.kind === 'location' && group.locationId ? db.locations.get(group.locationId) : undefined), [group])
  useEffect(() => {
    if (group?.kind === 'location') void syncContactLocationsAt(new Date())
  }, [group?.kind, group?.locationId])
  const locationParticipants = useLiveQuery(
    () => group?.kind === 'location' && group.locationId ? resolveLocationParticipants(group.locationId) : undefined,
    [group?.kind, group?.locationId],
  )
  const groupPlans = useLiveQuery(() => (groupId ? db.groupPlans.where('groupId').equals(groupId).reverse().sortBy('createdAt') : []), [groupId]) ?? []
  const allContacts = (useLiveQuery(() => db.contacts.toArray(), []) ?? EMPTY_CONTACTS).filter((item) => !isAiTestId(item.id))
  const membersRaw = useLiveQuery(() => (group ? db.contacts.bulkGet(group.memberContactIds) : []), [group])
  const stickers = useLiveQuery(() => db.stickers.toArray(), []) ?? []
  const groupWorldview = useLiveQuery(() => settings.activeWorldId ? db.worldbookCollections.get(settings.activeWorldId) : undefined, [settings.activeWorldId])
  const members = useMemo(() => locationParticipants?.activeMembers ?? (membersRaw ?? []).filter((c): c is Contact => !!c), [locationParticipants, membersRaw])

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
      ? (group.kind === 'location' ? buildLocationRawChatPrompt : buildGroupRawChatPrompt)({
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
          knowledgeDigestText: undefined,
          speakerMemoriesMap: new Map(),
          enabledModules: settings.enabledModules,
          locationContextText: groupLocation
            ? `当前地点：${groupLocation.name}\n地点描述：${groupLocation.description}\n设备现实时间：${describeCurrentTime(new Date())}\n现实季节：${realSeason(new Date())}\n人物位置与听觉状态：\n${[
                ...(locationParticipants?.here ?? []).map((contact) => `- ${displayName(contact)}：here`),
                ...(locationParticipants?.audible ?? []).map(({ contact, audibility }) => `- ${displayName(contact)}：${audibility}`),
              ].join('\n') || '当前无人'}`
            : undefined,
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
    const remaining = group.memberContactIds.filter((id) => id !== contactId)
    if (remaining.length <= 1) { await handleDisband(); return }
    await db.groups.update(group.id, { memberContactIds: remaining })
  }

  async function handleDisband() {
    if (!group) return
    const conv = await db.conversations.where('groupId').equals(group.id).first()
    if (conv) {
      await db.messages.where('conversationId').equals(conv.id).delete()
      await db.mediaAssets.where('conversationId').equals(conv.id).delete()
      await db.conversations.delete(conv.id)
    }
    await db.groups.delete(group.id)
    void navigate('/', { replace: true })
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
    <div className="relative flex h-[var(--app-height)] flex-col overflow-hidden bg-[var(--ui-bg)]">
      <TopBar title="群聊信息" showBack />

      <div className="flex-1 overflow-y-auto">
        <section className="border-b border-[var(--ui-border-soft)] bg-[var(--ui-surface)] px-4 pb-5 pt-4">
          <div className="flex items-center gap-4">
            <Avatar avatar={group.avatar} color={group.avatarColor} size={68} />
            <div className="min-w-0 flex-1">
              <button onClick={group.kind === 'location' ? undefined : openNameEditor} className="ui-font-display block max-w-full truncate text-left text-xl font-semibold text-[var(--ui-text)] active:opacity-70">
                {group.name}
              </button>
              <p className="mt-1 truncate text-xs text-[var(--ui-text-3)]">{group.kind === 'location' ? groupLocation?.name ?? '尚未选择地点' : groupWorldview?.name || '默认世界'} · {members.length} 位成员</p>
            </div>
            {group.kind !== 'location' && <button type="button" onClick={openNameEditor} className="shrink-0 text-xs text-[var(--ui-link)]">修改名称</button>}
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-2)] px-2 py-2.5"><p className="text-[10px] text-[var(--ui-text-3)]">成员</p><p className="mt-1 text-sm font-semibold text-[var(--ui-text)]">{members.length} 人</p></div>
            <div className="rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-2)] px-2 py-2.5"><p className="text-[10px] text-[var(--ui-text-3)]">共同计划</p><p className="mt-1 text-sm font-semibold text-[var(--ui-text)]">{groupPlans.length} 项</p></div>
            <div className="rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-2)] px-2 py-2.5"><p className="text-[10px] text-[var(--ui-text-3)]">群聊近况</p><p className="mt-1 text-sm font-semibold text-[var(--ui-text)]">{group.memory || group.vibe ? '已沉淀' : '待形成'}</p></div>
          </div>
        </section>

        {group.kind === 'location' && (
          <section className="mx-3 mt-3 rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] px-4 py-4 shadow-[var(--ui-shadow)]">
            <div className="flex items-center justify-between gap-3">
              <div><h3 className="text-xs font-medium text-gray-400">当前地点</h3><p className="mt-1 text-sm text-gray-900">{groupLocation?.name ?? '未选择地点'}</p><p className="mt-1 text-xs leading-relaxed text-gray-400">{groupLocation?.description ?? '请从地点地图选择一个具体地点。'}</p></div>
              <button type="button" onClick={() => navigate('/locations')} className="shrink-0 rounded-full bg-[var(--ui-special-soft)] px-3 py-1.5 text-xs text-[var(--ui-special-ink)]">打开地图</button>
            </div>
          </section>
        )}

        {group.kind === 'location' && locationParticipants && <section className="mx-3 mt-3 rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] px-4 py-4 shadow-[var(--ui-shadow)]">
          <h3 className="mb-3 text-xs font-medium text-gray-400">现场人物</h3>
          {([
            ['正在这里', locationParticipants.here],
            ['附近能听见', locationParticipants.audible.map((item) => item.contact)] as [string, Contact[]],
            ['不在这里', locationParticipants.away],
          ] as Array<[string, Contact[]]>).map(([label, contacts]) => <div key={label} className="mb-3 last:mb-0"><p className="mb-1 text-[11px] text-gray-400">{label} · {contacts.length}</p>{contacts.length === 0 ? <p className="px-2 text-xs text-gray-300">暂无</p> : <div className="space-y-1">{contacts.map((contact) => <button type="button" key={contact.id} onClick={() => navigate(`/contact/${contact.id}`)} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left active:bg-gray-50"><Avatar avatar={contact.avatar} color={contact.avatarColor} size={34} /><span className="min-w-0 flex-1 truncate text-sm text-gray-800">{displayName(contact)}</span><span className="max-w-28 truncate text-[10px] text-gray-400">{contact.currentLocationId}</span></button>)}</div>}</div>)}
        </section>}

        <section className="mx-3 mt-3 rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] px-4 py-4 shadow-[var(--ui-shadow)]">
          <h3 className="ui-font-display text-sm font-semibold text-[var(--ui-text)]">群聊近况</h3>
          <p className="mt-1 text-[11px] text-[var(--ui-text-3)]">由群聊总结逐渐沉淀，帮助成员保持共同语境。</p>
          <div className="mt-3 space-y-2">
            <div className="rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-2)] px-3 py-3"><p className="text-[11px] text-[var(--ui-text-3)]">共同记忆</p><p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-[var(--ui-text-2)]">{group.memory || '还没有形成稳定的群聊记忆。'}</p></div>
            <div className="rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-2)] px-3 py-3"><p className="text-[11px] text-[var(--ui-text-3)]">相处氛围</p><p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-[var(--ui-text-2)]">{group.vibe || '还没有形成明确的群聊氛围。'}</p></div>
          </div>
        </section>

        <section className="mx-3 mt-3 rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] px-4 py-4 shadow-[var(--ui-shadow)]">
          <h3 className="ui-font-display mb-1 text-sm font-semibold text-[var(--ui-text)]">共同计划</h3>
          <p className="mb-3 text-[11px] text-[var(--ui-text-3)]">群聊里已经形成的约定和下一步行动。</p>
          {groupPlans.length === 0 ? <p className="text-sm text-gray-400">群聊中形成明确约定后，会自动出现在这里。</p> : <div className="space-y-2">{groupPlans.map((plan: GroupPlan) => <div key={plan.id} className="rounded-lg bg-gray-50 p-3"><p className="text-sm font-medium text-gray-900">{plan.title}</p><p className="mt-1 text-xs text-gray-500">{plan.summary}{plan.location ? ` · ${plan.location}` : ''}</p><p className="mt-1 text-[11px] text-gray-400">{plan.status === 'pending' ? '待确认' : plan.status === 'confirmed' ? '已确认' : plan.status === 'completed' ? '已成行' : '已取消'}</p>{plan.status === 'pending' && <div className="mt-2 flex gap-2"><button type="button" onClick={() => void setGroupPlanStatus(plan, group, 'confirmed', settings)} className="rounded-md bg-gray-900 px-2.5 py-1 text-xs text-white">确认成行</button><button type="button" onClick={() => void setGroupPlanStatus(plan, group, 'cancelled', settings)} className="rounded-md bg-white px-2.5 py-1 text-xs text-gray-500">取消</button></div>}{plan.status === 'confirmed' && <div className="mt-2 flex gap-2"><button type="button" onClick={() => void setGroupPlanStatus(plan, group, 'completed', settings)} className="rounded-md bg-green-600 px-2.5 py-1 text-xs text-white">已成行</button><button type="button" onClick={() => void setGroupPlanStatus(plan, group, 'cancelled', settings)} className="rounded-md bg-white px-2.5 py-1 text-xs text-gray-500">取消</button></div>}</div>)}</div>}
        </section>

        <details className="mx-3 mt-3 rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] px-4 shadow-[var(--ui-shadow)]">
          <summary className="flex cursor-pointer list-none items-center justify-between py-4">
            <span><span className="ui-font-display block text-sm font-semibold text-[var(--ui-text)]">群聊互动设置</span><span className="mt-1 block text-[11px] text-[var(--ui-text-3)]">发言人数、互动方式、热闹程度与朋友圈引用</span></span>
            <span className="text-[var(--ui-text-3)]">⌄</span>
          </summary>
          <div className="border-t border-[var(--ui-border-soft)] pb-4 pt-4">
          <h3 className="mb-2 text-xs font-medium text-[var(--ui-text-3)]">每轮发言人数</h3>
          <div className="grid grid-cols-5 gap-2">
            {SPEAKER_LIMIT_OPTIONS.map((option) => {
              const checked = (group.speakerLimit ?? 3) === option
              return (
                <button
                  key={String(option)}
                  onClick={() => void updateGroup({ speakerLimit: option })}
                  className={`rounded-lg border px-2 py-2 text-sm ${
                    checked ? 'border-[var(--ui-action)] bg-[var(--ui-action)] text-[var(--ui-on-action)]' : 'border-[var(--ui-border)] bg-[var(--ui-surface)] text-[var(--ui-text-2)]'
                  }`}
                >
                  {speakerLimitLabel(option)}
                </button>
              )
            })}
          </div>
          <h3 className="mb-2 mt-5 text-xs font-medium text-[var(--ui-text-3)]">AI 是否可以互相聊起来</h3>
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
                    checked ? 'border-[var(--ui-action)] bg-[var(--ui-action)] text-[var(--ui-on-action)]' : 'border-[var(--ui-border)] bg-[var(--ui-surface)] text-[var(--ui-text-2)]'
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
          <h3 className="mb-2 mt-5 text-xs font-medium text-[var(--ui-text-3)]">群聊热闹程度</h3>
          <div className="grid grid-cols-3 gap-2">
            {ENERGY_OPTIONS.map((option) => {
              const checked = (group.energyLevel ?? 'normal') === option.value
              return (
                <button
                  key={option.value}
                  onClick={() => void updateGroup({ energyLevel: option.value })}
                  className={`rounded-lg border px-3 py-2 text-left ${
                    checked ? 'border-[var(--ui-action)] bg-[var(--ui-action)] text-[var(--ui-on-action)]' : 'border-[var(--ui-border)] bg-[var(--ui-surface)] text-[var(--ui-text-2)]'
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
          <h3 className="mb-2 mt-5 text-xs font-medium text-[var(--ui-text-3)]">朋友圈素材</h3>
          <div className="grid grid-cols-3 gap-2">
            {([
              ['enabled', '允许引用'], ['relationshipOnly', '仅关系'], ['private', '群内私密'],
            ] as const).map(([value, label]) => <button key={value} type="button" onClick={() => void updateGroup({ momentSharing: value })} className={`rounded-[var(--ui-radius-control)] border px-2 py-2 text-xs ${(group.momentSharing ?? 'enabled') === value ? 'border-[var(--ui-action)] bg-[var(--ui-action)] text-[var(--ui-on-action)]' : 'border-[var(--ui-border)] text-[var(--ui-text-2)]'}`}>{label}</button>)}
          </div>
          </div>
        </details>

        {group.kind !== 'location' && <section className="mx-3 mt-3 rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] px-4 py-4 shadow-[var(--ui-shadow)]">
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
        </section>}

        {adminEnabled && (
          <>
            <section className="mx-3 mt-3 rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] px-4 py-4 shadow-[var(--ui-shadow)]">
              <h3 className="mb-2 text-xs font-medium text-gray-400">各个AI的内部意图</h3>
              <AdminIntentList members={members} />
            </section>

            <section className="mx-3 mt-3 rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] px-4 py-4 shadow-[var(--ui-shadow)]">
              <h3 className="mb-2 text-xs font-medium text-gray-400">最新群聊原始JSON</h3>
              <LatestGroupAiTurnJson groupId={group.id} />
            </section>

            <section className="mx-3 mt-3 rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] px-4 py-4 shadow-[var(--ui-shadow)]">
              <h3 className="mb-2 text-xs font-medium text-gray-400">提示词预览</h3>
              {promptPreview ? (
                <div className="space-y-4">
                  <div className="rounded-lg border-2 border-gray-800">
                    <div className="border-b border-gray-200 bg-gray-100 px-3 py-1.5">
                      <span className="text-xs font-bold text-gray-800">发给主模型（{settings.model}）</span>
                      <span className="ml-2 text-[10px] text-gray-400">群聊纯文本草稿</span>
                    </div>
                    <pre className="whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-gray-700">
                      {promptPreview}
                    </pre>
                  </div>

                  <div className="rounded-lg border-2 border-gray-800">
                    <div className="border-b border-gray-200 bg-gray-100 px-3 py-1.5">
                      <span className="text-xs font-bold text-gray-800">发给多功能模型（{settings.utilityModel}）</span>
                      <span className="ml-2 text-[10px] text-gray-400">纯文本 → 群聊JSON</span>
                    </div>
                    <pre className="whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-gray-700">
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

        {group.kind !== 'location' && <section className="mx-3 mb-5 mt-6 rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] px-4 py-4 shadow-[var(--ui-shadow)]">
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
        </section>}
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
