import { useMemo, useState, type CSSProperties } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate } from 'react-router-dom'
import { Avatar } from '../components/Avatar'
import { TopBar } from '../components/TopBar'
import { db } from '../db/db'
import { isAiTestId } from '../lib/aiTestIsolation'
import { displayName } from '../lib/contact'
import { uniqueRelationPairs } from '../lib/contactRelations'
import { useSettingsStore } from '../store/useSettingsStore'
import type { Contact, ContactRelationLink } from '../types'

const EMPTY_CONTACTS: Contact[] = []
const EMPTY_RELATIONS: ContactRelationLink[] = []
const VIEW_WIDTH = 360
const VIEW_HEIGHT = 470
const CENTER = { x: VIEW_WIDTH / 2, y: 226 }
const USER_ID = 'user'
const ACTIVE_EDGE_COLOR = '#3b82f6'
const INACTIVE_EDGE_COLOR = '#94a3b8'

interface GraphPoint {
  x: number
  y: number
}

interface GraphEdge {
  id: string
  kind: 'user' | 'ai'
  fromId: string
  toId: string
  from: GraphPoint
  to: GraphPoint
  control?: GraphPoint
  label: string
  contact?: Contact
  relation?: ContactRelationLink
}

function pointsOnEllipse(count: number, radiusX: number, radiusY: number, offset = -Math.PI / 2 + 0.2): GraphPoint[] {
  return Array.from({ length: count }, (_, index) => {
    const angle = offset + (index * Math.PI * 2) / count
    return {
      x: CENTER.x + Math.cos(angle) * radiusX,
      y: CENTER.y + Math.sin(angle) * radiusY,
    }
  })
}

export function relationshipGraphPositions(count: number): GraphPoint[] {
  if (count <= 0) return []
  if (count <= 8) return pointsOnEllipse(count, 142, 164)

  const innerCount = Math.min(7, Math.ceil(count * 0.42))
  const outerCount = count - innerCount
  return [
    ...pointsOnEllipse(innerCount, 88, 105, -Math.PI / 2 + Math.PI / Math.max(innerCount, 1) + 0.16),
    ...pointsOnEllipse(outerCount, 148, 180, -Math.PI / 2 + 0.2),
  ]
}

function nodePositionStyle(point: GraphPoint): CSSProperties {
  return {
    left: `${(point.x / VIEW_WIDTH) * 100}%`,
    top: `${(point.y / VIEW_HEIGHT) * 100}%`,
  }
}

function relationControlPoint(from: GraphPoint, to: GraphPoint, key: string): GraphPoint {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.max(1, Math.hypot(dx, dy))
  const hash = Array.from(key).reduce((sum, character) => sum + character.charCodeAt(0), 0)
  const direction = hash % 2 === 0 ? 1 : -1
  const bend = Math.min(38, Math.max(18, length * 0.13)) * direction
  return {
    x: (from.x + to.x) / 2 + (-dy / length) * bend,
    y: (from.y + to.y) / 2 + (dx / length) * bend,
  }
}

function edgePath(edge: GraphEdge): string {
  if (!edge.control) return `M ${edge.from.x} ${edge.from.y} L ${edge.to.x} ${edge.to.y}`
  return `M ${edge.from.x} ${edge.from.y} Q ${edge.control.x} ${edge.control.y} ${edge.to.x} ${edge.to.y}`
}

function edgeLabelPoint(edge: GraphEdge): GraphPoint {
  if (!edge.control) {
    const ratio = 0.58
    return {
      x: edge.from.x + (edge.to.x - edge.from.x) * ratio,
      y: edge.from.y + (edge.to.y - edge.from.y) * ratio,
    }
  }
  return {
    x: edge.from.x * 0.25 + edge.control.x * 0.5 + edge.to.x * 0.25,
    y: edge.from.y * 0.25 + edge.control.y * 0.5 + edge.to.y * 0.25,
  }
}

export function RelationshipsPage() {
  const navigate = useNavigate()
  const contactsRaw = useLiveQuery(() => db.contacts.toArray(), []) ?? EMPTY_CONTACTS
  const relationRows = useLiveQuery(() => db.contactRelations.toArray(), []) ?? EMPTY_RELATIONS
  const userAvatar = useSettingsStore((state) => state.userAvatar)
  const userNickname = useSettingsStore((state) => state.userNickname)
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)

  const contacts = useMemo(
    () => contactsRaw
      .filter((contact) => !isAiTestId(contact.id))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    [contactsRaw],
  )
  const contactById = useMemo(() => new Map(contacts.map((contact) => [contact.id, contact])), [contacts])
  const contactIndex = useMemo(() => new Map(contacts.map((contact, index) => [contact.id, index])), [contacts])
  const positions = useMemo(() => relationshipGraphPositions(contacts.length), [contacts.length])
  const relations = useMemo(
    () => uniqueRelationPairs(relationRows).filter((relation) => (
      contactById.has(relation.fromContactId) && contactById.has(relation.toContactId)
    )),
    [contactById, relationRows],
  )

  const graphEdges = useMemo<GraphEdge[]>(() => {
    const userEdges = contacts.map((contact, index): GraphEdge => ({
      id: `user:${contact.id}`,
      kind: 'user',
      fromId: USER_ID,
      toId: contact.id,
      from: CENTER,
      to: positions[index],
      label: contact.relationshipBase?.trim() || '未设置关系',
      contact,
    }))
    const aiEdges = relations.flatMap((relation): GraphEdge[] => {
      const fromIndex = contactIndex.get(relation.fromContactId)
      const toIndex = contactIndex.get(relation.toContactId)
      if (fromIndex === undefined || toIndex === undefined) return []
      const from = positions[fromIndex]
      const to = positions[toIndex]
      return [{
        id: `ai:${relation.id}`,
        kind: 'ai',
        fromId: relation.fromContactId,
        toId: relation.toContactId,
        from,
        to,
        control: relationControlPoint(from, to, relation.pairId || relation.id),
        label: relation.label,
        relation,
      }]
    })
    return [...userEdges, ...aiEdges]
  }, [contactIndex, contacts, positions, relations])

  const edgeIsActive = (edge: GraphEdge) => selectedContactId
    ? edge.fromId === selectedContactId || edge.toId === selectedContactId
    : edge.kind === 'user'
  const activeEdges = graphEdges.filter(edgeIsActive)
  const connectedIds = new Set(activeEdges.flatMap((edge) => [edge.fromId, edge.toId]))
  const selectedContact = selectedContactId ? contactById.get(selectedContactId) : undefined
  const selectedEdge = selectedEdgeId ? graphEdges.find((edge) => edge.id === selectedEdgeId) : undefined
  const selectedAiRelations = selectedContactId
    ? relations.filter((relation) => relation.fromContactId === selectedContactId || relation.toContactId === selectedContactId)
    : []
  const renderedEdges = [...graphEdges].sort((a, b) => Number(edgeIsActive(a)) - Number(edgeIsActive(b)))

  const focusContact = (contactId: string) => {
    setSelectedContactId(contactId)
    setSelectedEdgeId(null)
  }

  const focusUser = () => {
    setSelectedContactId(null)
    setSelectedEdgeId(null)
  }

  return (
    <div className="ui-page">
      <TopBar title="关系网" showBack />
      <div className="ui-page-scroll">
        {contacts.length === 0 ? (
          <div className="ui-empty-state">还没有联系人，创建联系人后会在这里形成关系网。</div>
        ) : (
          <section className="mx-3 mt-3 overflow-hidden rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] shadow-[var(--ui-shadow)] lg:mx-auto lg:max-w-[900px]">
            <div className="flex min-h-14 items-center justify-between gap-3 border-b border-[var(--ui-border-soft)] px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-[var(--ui-text)]">
                    {selectedContact ? `正在查看 ${displayName(selectedContact)}` : `正在查看 ${userNickname || '我'}`}
                  </p>
                </div>
                <p className="mt-1 truncate text-[11px] text-[var(--ui-text-3)]">
                  蓝色是当前人物的关系，灰色是关系网中的其他连接
                </p>
              </div>
              <span className="shrink-0 text-[11px] text-[var(--ui-text-3)]">
                {contacts.length} 人 · {relations.length} 条 AI 关系
              </span>
            </div>

            <div
              className="relative h-[470px] overflow-hidden lg:h-[520px]"
              style={{ background: 'radial-gradient(circle at 50% 48%, rgba(59,130,246,.075), transparent 29%), var(--ui-bg)' }}
            >
              <svg
                viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
                preserveAspectRatio="none"
                className="absolute inset-0 h-full w-full"
                role="img"
                aria-label={selectedContact ? `${displayName(selectedContact)}的关系高亮图` : '用户与全部AI联系人的关系高亮图'}
              >
                {renderedEdges.map((edge) => {
                  const active = edgeIsActive(edge)
                  return (
                    <path
                      key={edge.id}
                      d={edgePath(edge)}
                      fill="none"
                      stroke={active ? ACTIVE_EDGE_COLOR : INACTIVE_EDGE_COLOR}
                      strokeWidth={active ? 2.25 : 1.2}
                      strokeOpacity={active ? 0.9 : 0.3}
                      vectorEffect="non-scaling-stroke"
                    />
                  )
                })}
              </svg>

              {renderedEdges.map((edge) => {
                const active = edgeIsActive(edge)
                const selected = selectedEdgeId === edge.id
                return (
                  <button
                    type="button"
                    key={edge.id}
                    onClick={() => setSelectedEdgeId(edge.id)}
                    className={`absolute z-20 max-w-28 -translate-x-1/2 -translate-y-1/2 truncate px-1.5 py-0.5 text-[10px] transition-opacity ${active
                      ? 'bg-[var(--ui-bg)] text-[#2563eb] opacity-100'
                      : 'bg-[var(--ui-bg)] text-[var(--ui-text-3)] opacity-45'
                    } ${selected ? 'font-medium underline underline-offset-2' : ''}`}
                    style={nodePositionStyle(edgeLabelPoint(edge))}
                    aria-label={`${edge.label}，点击查看关系详情`}
                  >
                    {edge.label}
                  </button>
                )
              })}

              <button
                type="button"
                onClick={focusUser}
                aria-pressed={!selectedContactId}
                aria-label="我，点击查看我与全部联系人的关系"
                className={`absolute z-30 flex w-[78px] -translate-x-1/2 -translate-y-1/2 flex-col items-center transition-opacity ${selectedContactId ? 'opacity-65' : 'opacity-100'}`}
                style={nodePositionStyle(CENTER)}
              >
                <span className={`rounded-2xl p-1 ${selectedContactId ? '' : 'ring-2 ring-[#3b82f6]'}`}>
                  <Avatar avatar={userAvatar} color="#3b82f6" size={50} />
                </span>
                <span className="mt-1 max-w-[78px] truncate text-xs font-medium text-[var(--ui-text)]">
                  {userNickname || '我'}
                </span>
                <span className="text-[9px] text-[#3b82f6]">我</span>
              </button>

              {contacts.map((contact, index) => {
                const selected = contact.id === selectedContactId
                const dimmed = Boolean(selectedContactId && !connectedIds.has(contact.id))
                return (
                  <button
                    type="button"
                    key={contact.id}
                    onClick={() => focusContact(contact.id)}
                    aria-pressed={selected}
                    aria-label={`${displayName(contact)}${dimmed ? '，与当前人物没有直接关系' : ''}`}
                    className={`absolute z-30 flex w-[78px] -translate-x-1/2 -translate-y-1/2 flex-col items-center transition-opacity ${dimmed ? 'opacity-30' : 'opacity-100'}`}
                    style={nodePositionStyle(positions[index])}
                  >
                    <span className={`rounded-2xl p-1 ${selected ? 'ring-2 ring-[#3b82f6]' : ''}`}>
                      <Avatar avatar={contact.avatar} color={contact.avatarColor} size={46} />
                    </span>
                    <span className={`mt-1 max-w-[78px] truncate text-[11px] font-medium ${selected ? 'text-[#2563eb]' : 'text-[var(--ui-text)]'}`}>
                      {displayName(contact)}
                    </span>
                  </button>
                )
              })}
            </div>

            <div className="border-t border-[var(--ui-border-soft)] bg-[var(--ui-surface)] px-4 py-4">
              {selectedEdge ? (
                <EdgeDetail edge={selectedEdge} userNickname={userNickname || '我'} />
              ) : selectedContact ? (
                <div className="flex items-center gap-3">
                  <Avatar avatar={selectedContact.avatar} color={selectedContact.avatarColor} size={44} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-medium text-[var(--ui-text)]">{displayName(selectedContact)}</p>
                    <p className="mt-0.5 text-xs text-[var(--ui-text-3)]">
                      与我：{selectedContact.relationshipBase || '未设置关系'} · 与 {selectedAiRelations.length} 位 AI 有关系记录
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => navigate(`/contact/${selectedContact.id}`)}
                    className="shrink-0 text-xs text-[#2563eb]"
                  >
                    查看名片
                  </button>
                </div>
              ) : (
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-[var(--ui-text)]">关系全景</p>
                    <p className="mt-1 text-xs leading-relaxed text-[var(--ui-text-3)]">
                      蓝线显示我与每位 AI 的设定关系；灰线保留 AI 之间已经存在的关系。点击任意人物即可切换焦点。
                    </p>
                  </div>
                  <div className="mt-0.5 flex shrink-0 items-center gap-3 text-[10px] text-[var(--ui-text-3)]">
                    <span className="flex items-center gap-1"><i className="block h-0.5 w-4 bg-[#3b82f6]" />当前关系</span>
                    <span className="flex items-center gap-1"><i className="block h-px w-4 bg-[#94a3b8]" />其他关系</span>
                  </div>
                </div>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

function EdgeDetail({ edge, userNickname }: { edge: GraphEdge; userNickname: string }) {
  if (edge.kind === 'user' && edge.contact) {
    return (
      <div>
        <p className="text-sm font-medium text-[var(--ui-text)]">{userNickname} · {displayName(edge.contact)}</p>
        <p className="mt-1 text-xs text-[#2563eb]">{edge.label}</p>
        {edge.contact.relationshipDynamic && (
          <p className="mt-2 text-xs leading-relaxed text-[var(--ui-text-3)]">{edge.contact.relationshipDynamic}</p>
        )}
      </div>
    )
  }

  if (!edge.relation) return null
  return <AiRelationDetail relation={edge.relation} />
}

function AiRelationDetail({ relation }: { relation: ContactRelationLink }) {
  const contacts = useLiveQuery(
    () => db.contacts.bulkGet([relation.fromContactId, relation.toContactId]),
    [relation.fromContactId, relation.toContactId],
  )
  const from = contacts?.[0]
  const to = contacts?.[1]
  if (!from || !to) return null

  return (
    <div>
      <p className="text-sm font-medium text-[var(--ui-text)]">{displayName(from)} · {displayName(to)}</p>
      <p className="mt-1 text-xs text-[#2563eb]">{relation.label}</p>
      {relation.dynamicSummary && (
        <p className="mt-2 text-xs leading-relaxed text-[var(--ui-text-3)]">{relation.dynamicSummary}</p>
      )}
    </div>
  )
}
