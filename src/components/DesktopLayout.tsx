import { useMemo, useState, type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useLocation, useNavigate } from 'react-router-dom'
import { db } from '../db/db'
import { Avatar } from './Avatar'
import { UnreadBadge } from './UnreadBadge'
import { DesktopTitleBar } from './DesktopTitleBar'
import { useLastMessageByConversation, useTotalUnread, useUnreadByConversation } from '../lib/unread'
import { previewForMessage } from '../lib/messagePreview'
import { displayName } from '../lib/contact'
import { formatListTime } from '../lib/time'
import { momentsUnreadCount } from '../lib/momentsUnread'
import { useSettingsStore } from '../store/useSettingsStore'
import { ALL_MODULES, useModuleEnabled } from '../features'
import { uiThemeName } from '../lib/uiTheme'
import { UiIcon } from './UiIcon'
import { isAiTestId } from '../lib/aiTestIsolation'
import { claimDailySalaries, localDateKey } from '../lib/finance'
import { formatCurrency } from '../lib/wallet'
import { checkForUpdate } from '../lib/updateCheck'

const EMPTY: never[] = []

type DesktopSection = 'messages' | 'contacts' | 'discover' | 'sky-eye' | 'settings'

function sectionForPath(path: string): DesktopSection {
  if (path === '/' || path.startsWith('/chat/')) return 'messages'
  if (path.startsWith('/contact') || path.startsWith('/group')) return 'contacts'
  if (path === '/sky-eye') return 'sky-eye'
  if (path === '/me' || path === '/appearance' || path === '/experience-mode' || path.startsWith('/settings') || path.startsWith('/profile') || path.startsWith('/stickers') || path === '/modules' || path.startsWith('/save-load')) return 'settings'
  return 'discover'
}

export function DesktopLayout({ children }: { children: ReactNode }) {
  const location = useLocation()
  const navigate = useNavigate()
  const section = sectionForPath(location.pathname)
  const detailMode = location.pathname === '/sky-eye'

  return (
    <div className="desktop-layout">
      <DesktopTitleBar />
      <div className={`desktop-body ${detailMode ? 'desktop-detail-mode' : ''}`}>
        <DesktopRail section={section} onNavigate={navigate} />
        <DesktopSidebar section={section} />
        <main className="desktop-main">{children}</main>
      </div>
    </div>
  )
}

function DesktopRail({ section, onNavigate }: { section: DesktopSection; onNavigate: ReturnType<typeof useNavigate> }) {
  const settings = useSettingsStore()
  const totalUnread = useTotalUnread()
  const moments = useLiveQuery(() => db.moments.toArray(), []) ?? EMPTY
  const socialEvents = useLiveQuery(() => db.socialEvents.toArray(), []) ?? EMPTY
  const momentsUnread = momentsUnreadCount({ lastReadAt: settings.momentsLastReadAt, moments, socialEvents })
  const items: Array<{ section: DesktopSection; to: string; label: string; badge?: number }> = [
    { section: 'messages', to: '/', label: '消息', badge: totalUnread },
    { section: 'contacts', to: '/contacts', label: '联系人' },
    { section: 'discover', to: '/moments', label: '朋友圈', badge: momentsUnread },
  ]
  if (settings.adminModeEnabled) items.push({ section: 'sky-eye', to: '/sky-eye', label: '天眼' })

  return (
    <nav className="desktop-rail" aria-label="桌面主导航">
      <button type="button" className="desktop-user-avatar" onClick={() => onNavigate('/profile/edit')} title="编辑个人信息">
        <Avatar avatar={settings.userAvatar} size={42} />
      </button>
      {items.map((item) => (
        <button
          type="button"
          key={item.section}
          className={`desktop-rail-button ${section === item.section ? 'active' : ''}`}
          onClick={() => onNavigate(item.to)}
          title={item.label}
        >
          <RailIcon section={item.section} />
          <UnreadBadge count={item.badge ?? 0} className="absolute -top-0.5 -right-0.5" />
        </button>
      ))}
      <div className="desktop-rail-spacer" />
      <button
        type="button"
        className={`desktop-rail-button ${section === 'settings' ? 'active' : ''}`}
        onClick={() => onNavigate('/settings')}
        title="设置"
      >
        <RailIcon section="settings" />
      </button>
    </nav>
  )
}

function RailIcon({ section }: { section: DesktopSection }) {
  if (section === 'messages') return <svg className="desktop-rail-svg" viewBox="0 0 24 24" fill="none"><path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-4.4 3.3A.6.6 0 0 1 3 19.8V6a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" /></svg>
  if (section === 'contacts') return <svg className="desktop-rail-svg" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.7" /><path d="M5 19c1.2-3.2 3.8-5 7-5s5.8 1.8 7 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
  if (section === 'discover') return <svg className="desktop-rail-svg" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.7" /><path d="m15 9-2 5-4 1.5 2-5 4-1.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
  if (section === 'sky-eye') return <svg className="desktop-rail-svg" viewBox="0 0 24 24" fill="none"><path d="M2.8 12s3.3-5 9.2-5 9.2 5 9.2 5-3.3 5-9.2 5-9.2-5-9.2-5Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" /><circle cx="12" cy="12" r="2.7" stroke="currentColor" strokeWidth="1.7" /></svg>
  return <svg className="desktop-rail-svg" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.7" /><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1A8 8 0 0 0 15 6l-.3-2.6h-4L10.5 6A8 8 0 0 0 9 7.1l-2.4-1-2 3.4 2 1.5a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.4-1A8 8 0 0 0 10.5 18l.2 2.6h4L15 18a8 8 0 0 0 1.5-1.1l2.4 1 2-3.4-2-1.5a7 7 0 0 0 .1-1Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>
}

function DesktopSidebar({ section }: { section: DesktopSection }) {
  const [query, setQuery] = useState('')
  const [showCreateMenu, setShowCreateMenu] = useState(false)
  const navigate = useNavigate()
  return (
    <aside className="desktop-sidebar">
      <div className="desktop-sidebar-search">
        <label><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索" /></label>
        <button
          type="button"
          onClick={() => setShowCreateMenu((open) => !open)}
          title="新建"
          aria-label="新建"
          aria-expanded={showCreateMenu}
          className={section === 'messages' || section === 'contacts' ? '' : 'invisible'}
        >＋</button>
      </div>
      {showCreateMenu && (section === 'messages' || section === 'contacts') && (
        <div className="desktop-create-menu" role="menu" aria-label="新建菜单">
          <button type="button" role="menuitem" onClick={() => { setShowCreateMenu(false); void navigate('/contact/new') }}>
            添加联系人
          </button>
          <button type="button" role="menuitem" onClick={() => { setShowCreateMenu(false); void navigate('/group/new') }}>
            创建群聊
          </button>
        </div>
      )}
      <div className="desktop-sidebar-caption">
        {section === 'messages' ? '最近会话' : section === 'contacts' ? '联系人' : section === 'discover' ? '发现' : '个人与设置'}
      </div>
      <div className="desktop-sidebar-list">
        {section === 'messages' && <ConversationList query={query} />}
        {section === 'contacts' && <ContactList query={query} />}
        {section === 'discover' && <DiscoverList query={query} />}
        {section === 'settings' && <SettingsList query={query} />}
      </div>
    </aside>
  )
}

function ConversationList({ query }: { query: string }) {
  const navigate = useNavigate()
  const location = useLocation()
  const conversations = useLiveQuery(() => db.conversations.toArray(), []) ?? EMPTY
  const contacts = useLiveQuery(() => db.contacts.toArray(), []) ?? EMPTY
  const groups = useLiveQuery(() => db.groups.toArray(), []) ?? EMPTY
  const unread = useUnreadByConversation()
  const lastMessages = useLastMessageByConversation()
  const rows = useMemo(() => {
    const contactById = new Map(contacts.map((contact) => [contact.id, contact]))
    const groupById = new Map(groups.map((group) => [group.id, group]))
    return conversations.filter((conversation) => !isAiTestId(conversation.id) && !isAiTestId(conversation.contactId) && !isAiTestId(conversation.groupId)).map((conversation) => {
      const contact = conversation.contactId ? contactById.get(conversation.contactId) : undefined
      const group = conversation.groupId ? groupById.get(conversation.groupId) : undefined
      if (!contact && !group) return null
      const name = group?.name ?? displayName(contact!)
      return {
        conversation,
        name,
        avatar: group?.avatar ?? contact!.avatar,
        color: group?.avatarColor ?? contact!.avatarColor,
        preview: previewForMessage(lastMessages.get(conversation.id)),
      }
    }).filter((row): row is NonNullable<typeof row> => Boolean(row))
      .filter((row) => row.name.toLowerCase().includes(query.trim().toLowerCase()))
      .sort((a, b) => Number(b.conversation.pinned) - Number(a.conversation.pinned) || b.conversation.updatedAt - a.conversation.updatedAt)
  }, [contacts, conversations, groups, lastMessages, query])
  if (!rows.length) return <DesktopSidebarEmpty text={query ? '没有匹配的会话' : '还没有会话'} />
  return <>{rows.map((row) => (
    <button type="button" key={row.conversation.id} className={`desktop-list-row ${location.pathname === `/chat/${row.conversation.id}` ? 'active' : ''}`} onClick={() => navigate(`/chat/${row.conversation.id}`)}>
      <span className="relative"><Avatar avatar={row.avatar} color={row.color} size={48} /><UnreadBadge count={unread.get(row.conversation.id) ?? 0} className="absolute -top-1 -right-1" /></span>
      <span className="desktop-list-copy"><span className="desktop-list-top"><strong>{row.name}</strong><time>{formatListTime(row.conversation.updatedAt)}</time></span><small>{row.preview}</small></span>
    </button>
  ))}</>
}

function ContactList({ query }: { query: string }) {
  const navigate = useNavigate()
  const location = useLocation()
  const contacts = useLiveQuery(() => db.contacts.orderBy('createdAt').reverse().toArray(), []) ?? EMPTY
  const generationTasks = useLiveQuery(() => db.contactGenerationTasks.orderBy('createdAt').reverse().toArray(), []) ?? EMPTY
  const activeTasks = generationTasks.filter((task) => !['cancelled', 'completed'].includes(task.status))
  const filtered = contacts.filter((contact) => !isAiTestId(contact.id) && displayName(contact).toLowerCase().includes(query.trim().toLowerCase()))
  return <>
    <button type="button" className="desktop-list-row" onClick={() => navigate('/contact/new')}><span className="desktop-add-avatar"><UiIcon name="users" size={21} /></span><span className="desktop-list-copy"><strong>添加联系人</strong><small>创建一位新的 AI 联系人</small></span></button>
    {activeTasks.map((task) => {
      const title = task.experienceMode === 'immersive' ? '正在寻找联系人' : task.method === 'precision' ? '精细创建 · 女娲模式' : '正在生成联系人'
      const statusClass = task.status === 'failed' ? 'failed' : task.status === 'awaiting_review' ? 'ready' : 'working'
      return <button type="button" key={task.id} className={`desktop-list-row ${location.pathname === `/contact-generation/${task.id}` ? 'active' : ''}`} onClick={() => navigate(`/contact-generation/${task.id}`)}><span className={`desktop-menu-avatar desktop-generation-avatar ${statusClass}`}>{task.status === 'failed' ? '!' : task.status === 'awaiting_review' ? '✓' : '◌'}</span><span className="desktop-list-copy"><strong>{title}</strong><small>{task.stageLabel}</small></span></button>
    })}
    {filtered.map((contact) => <button type="button" key={contact.id} className={`desktop-list-row ${location.pathname === `/contact/${contact.id}` ? 'active' : ''}`} onClick={() => navigate(`/contact/${contact.id}`)}><Avatar avatar={contact.avatar} color={contact.avatarColor} size={48} /><span className="desktop-list-copy"><strong>{displayName(contact)}</strong><small>{contact.relationshipBase || '朋友'} · 认识于 {formatListTime(contact.createdAt)}</small></span></button>)}
  </>
}

function DiscoverList({ query }: { query: string }) {
  const navigate = useNavigate()
  const location = useLocation()
  const enabledModules = useSettingsStore((state) => state.enabledModules)
  const adminModeEnabled = useSettingsStore((state) => state.adminModeEnabled)
  const entries = useMemo(() => {
    const result = [{ to: '/moments', label: '朋友圈', icon: '◉', note: '查看朋友们的最新动态' }, { to: '/social-inbox', label: '互动收件箱', icon: '✦', note: '点赞、评论与回复' }]
    if (adminModeEnabled) result.push({ to: '/ai-test-cards', label: 'AI 自动测试', icon: '🧪', note: '后台运行人工评测用例' })
    result.push({ to: '/album', label: '相册', icon: '🖼️', note: '查看已生成和已使用的图片' })
    for (const module of ALL_MODULES) {
      if (!enabledModules.includes(module.id)) continue
      for (const entry of module.discoverEntries ?? []) result.push({ ...entry, note: '功能模块' })
    }
    return [...new Map(result.map((entry) => [entry.to, entry])).values()].filter((entry) => entry.label.includes(query.trim()))
  }, [adminModeEnabled, enabledModules, query])
  return <>{entries.map((entry) => <button type="button" key={entry.to} className={`desktop-list-row ${location.pathname === entry.to ? 'active' : ''}`} onClick={() => navigate(entry.to)}><span className="desktop-menu-avatar"><UiIcon name={entry.icon} size={20} /></span><span className="desktop-list-copy"><strong>{entry.label}</strong><small>{entry.note}</small></span></button>)}</>
}

function SettingsList({ query }: { query: string }) {
  const navigate = useNavigate()
  const location = useLocation()
  const settings = useSettingsStore()
  const careerEnabled = useModuleEnabled('career')
  const saveLoadEnabled = useModuleEnabled('saveLoad')
  const salaryClaim = useLiveQuery(() => db.walletTransactions.where('idempotencyKey').equals(`salary:user:${localDateKey()}`).first(), [])
  const [claimingSalary, setClaimingSalary] = useState(false)
  const [salaryMessage, setSalaryMessage] = useState('')
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [updateMessage, setUpdateMessage] = useState('')
  const [updateUrl, setUpdateUrl] = useState('')

  async function claimSalary() {
    setClaimingSalary(true)
    setSalaryMessage('')
    try {
      const result = await claimDailySalaries()
      setSalaryMessage(`已领取 ${formatCurrency(result.userAmount, settings)}，并为 ${result.contactCount} 位 AI 发放工资`)
    } catch (error) {
      setSalaryMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setClaimingSalary(false)
    }
  }

  async function handleCheckUpdate() {
    if (updateUrl) {
      window.open(updateUrl, '_blank')
      return
    }
    setCheckingUpdate(true)
    setUpdateMessage('')
    try {
      const result = await checkForUpdate()
      if (result.hasUpdate) {
        setUpdateMessage(`发现新版本 ${result.latestVersion}，点击前往下载`)
        setUpdateUrl(result.releaseUrl)
      } else {
        setUpdateMessage('已是最新版本')
      }
    } catch (error) {
      setUpdateMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setCheckingUpdate(false)
    }
  }

  const entries = [
    { to: '/profile/edit', label: settings.userNickname, note: '编辑个人信息', avatar: settings.userAvatar },
    { to: '/experience-mode', label: '体验模式', note: settings.experienceMode === 'immersive' ? '沉浸模式' : '自由模式', icon: '◈' },
    { to: '/appearance', label: '软件风格切换', note: `${uiThemeName(settings.uiTheme)} · ${settings.themeMode === 'dark' ? '深色' : '浅色'}`, icon: '◐' },
    { to: '/settings', label: '通用设置', note: '模型、数据与隐私', icon: '⚙' },
    { to: '/settings/other-interfaces', label: '其他接口', note: '图像、语音、Pexels、Tavily 与动漫图库', icon: '◌' },
    { to: '/modules', label: '功能模块', note: '启用或关闭扩展功能', icon: '▦' },
    { to: '/stickers', label: '表情包', note: '管理本地和远程表情', icon: '☺' },
    ...(saveLoadEnabled ? [{ to: '/save-load', label: '存档与回档', note: '保存和恢复完整世界状态', icon: '💾' }] : []),
  ].filter((entry) => entry.label.toLowerCase().includes(query.trim().toLowerCase()))
  const normalizedQuery = query.trim().toLowerCase()
  const showSalary = careerEnabled && '每日工资'.includes(normalizedQuery)
  const showUpdate = '检查更新'.includes(normalizedQuery)
  const profileEntry = entries.find((entry) => entry.to === '/profile/edit')
  const otherEntries = entries.filter((entry) => entry.to !== '/profile/edit')
  const renderEntry = (entry: (typeof entries)[number]) => <button type="button" key={entry.to} className={`desktop-list-row ${location.pathname === entry.to ? 'active' : ''}`} onClick={() => navigate(entry.to)}>{entry.avatar ? <Avatar avatar={entry.avatar} size={48} /> : <span className="desktop-menu-avatar"><UiIcon name={entry.icon ?? 'settings'} size={20} /></span>}<span className="desktop-list-copy"><strong>{entry.label}</strong><small>{entry.note}</small></span></button>

  return <>
    {profileEntry && renderEntry(profileEntry)}
    {showSalary && <button type="button" className="desktop-list-row" onClick={() => void claimSalary()} disabled={claimingSalary || !!salaryClaim || !settings.userOccupation}><span className="desktop-menu-avatar"><UiIcon name="💼" size={20} /></span><span className="desktop-list-copy"><strong>每日工资</strong><small>{salaryMessage || (claimingSalary ? '发放中…' : salaryClaim ? '今日已领取' : settings.userOccupation ? '点击领取，并为所有已入职 AI 发薪' : '尚未入职')}</small></span></button>}
    {otherEntries.map(renderEntry)}
    {showUpdate && <button type="button" className="desktop-list-row" onClick={() => void handleCheckUpdate()} disabled={checkingUpdate}><span className="desktop-menu-avatar"><UiIcon name="download" size={20} /></span><span className="desktop-list-copy"><strong>检查更新</strong><small>{checkingUpdate ? '检查中…' : updateMessage || `当前 v${__APP_VERSION__}`}</small></span></button>}
  </>
}

function DesktopSidebarEmpty({ text }: { text: string }) {
  return <p className="px-5 py-10 text-center text-xs text-gray-400">{text}</p>
}
