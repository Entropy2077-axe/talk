import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import Dexie from 'dexie'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { MessageBubble } from '../components/MessageBubble'
import { SearchOverlay } from '../components/SearchOverlay'
import { ActionSheet } from '../components/ActionSheet'
import { useSettingsStore } from '../store/useSettingsStore'
import { useModuleEnabled } from '../features'
import { useChatUiStore } from '../store/useChatUiStore'
import { DEFAULT_RUNTIME_STATE, regenerateAiTurn, sendMessage, triggerAiTurn, useChatEngineStore } from '../lib/chatEngine'
import { regenerateGroupAiTurn, sendGroupMessage, triggerGroupAiTurn } from '../lib/groupChatEngine'
import { displayName } from '../lib/contact'
import { applyMessageFeedback } from '../lib/messageFeedback'
import { buildPrivateStatusLine } from '../lib/contactStatus'
import { downloadDataUrl, generateChatCaptureImage, shareDataUrl } from '../lib/chatCapture'
import type { Contact, Message } from '../types'
import { v4 as uuid } from 'uuid'
import { claimRedPacket, transferFunds, USER_WALLET_ID } from '../lib/finance'
import { draftReply } from '../lib/aiReplyAssist'
import { searchRemoteStickers, trackRemoteStickerSend, type RemoteStickerResult } from '../lib/remoteMedia'
import { isStickerProviderReady, stickerProviderName } from '../lib/mediaProviders'
import { normalizeChatPageSize } from '../lib/chatPagination'

const EMPTY_MESSAGES: Message[] = []
const LONG_PRESS_HINT_KEY = 'talk-chat-long-press-hint-seen-v1'

export function ChatPage() {
  const { conversationId } = useParams()
  const [searchParams] = useSearchParams()
  const highlightId = searchParams.get('highlight')
  const navigate = useNavigate()
  const settings = useSettingsStore()
  const chatPageSize = normalizeChatPageSize(settings.chatPageSize)
  const setActiveConversation = useChatUiStore((s) => s.setActiveConversation)
  const mindReadingEnabled = useModuleEnabled('mindReading')
  const careerEnabled = useModuleEnabled('career')
  const replyAssistEnabled = useModuleEnabled('aiReplyAssist')

  const conversation = useLiveQuery(
    () => (conversationId ? db.conversations.get(conversationId) : undefined),
    [conversationId],
  )
  const isGroupConv = !!conversation?.groupId
  const contact = useLiveQuery(
    () => (conversation && !conversation.groupId ? db.contacts.get(conversation.contactId!) : undefined),
    [conversation],
  )
  const group = useLiveQuery(
    () => (conversation?.groupId ? db.groups.get(conversation.groupId) : undefined),
    [conversation],
  )
  const groupMembersRaw = useLiveQuery(
    () => (group ? db.contacts.bulkGet(group.memberContactIds) : []),
    [group],
  )
  const groupMembers = useMemo(() => (groupMembersRaw ?? []).filter((c): c is Contact => !!c), [groupMembersRaw])
  const memberById = useMemo(() => new Map(groupMembers.map((c) => [c.id, c])), [groupMembers])

  const [visibleMessageLimit, setVisibleMessageLimit] = useState(chatPageSize)
  useEffect(() => setVisibleMessageLimit(chatPageSize), [conversationId, chatPageSize])
  const messagePage = useLiveQuery(async () => {
    if (!conversationId) return { items: EMPTY_MESSAGES, total: 0 }
    const range = () => db.messages
      .where('[conversationId+createdAt]')
      .between([conversationId, Dexie.minKey], [conversationId, Dexie.maxKey], true, true)
    const [newestFirst, total] = await Promise.all([
      range().reverse().limit(visibleMessageLimit).toArray(),
      range().count(),
    ])
    return { items: newestFirst.reverse(), total }
  }, [conversationId, visibleMessageLimit])
  const messages = messagePage?.items ?? EMPTY_MESSAGES
  const latestMessageId = messages.at(-1)?.id
  const hasOlderMessages = messages.length < (messagePage?.total ?? 0)
  const stickers = useLiveQuery(() => db.stickers.toArray(), []) ?? []
  const stickerByName = new Map(stickers.map((s) => [s.name, s.dataUrl]))
  const [statusLine, setStatusLine] = useState('')
  useEffect(() => {
    // Group chats don't get a status line.
    if (isGroupConv) {
      setStatusLine('')
      return
    }
    if (!contact) {
      setStatusLine('')
      return
    }
    let cancelled = false
    buildPrivateStatusLine(contact).then((text) => {
      if (!cancelled) setStatusLine(text)
    })
    return () => {
      cancelled = true
    }
  }, [isGroupConv, contact])

  // The AI-turn state (typing indicator / error) lives in a module-level
  // store, not local state — it keeps running in the background even when
  // this page unmounts, so it must be read reactively from there instead.
  const { aiTyping, error, typingLabel } = useChatEngineStore(
    (s) => s.states[conversationId ?? ''] ?? DEFAULT_RUNTIME_STATE,
  )

  const [input, setInput] = useState('')
  const [toast, setToast] = useState('')
  const [showLongPressHint, setShowLongPressHint] = useState(false)
  const [searching, setSearching] = useState(false)
  const [selectedMentionIds, setSelectedMentionIds] = useState<string[]>([])
  const [replyToId, setReplyToId] = useState<string | null>(null)
  const [menuMessageId, setMenuMessageId] = useState<string | null>(null)
  const [selectingMessages, setSelectingMessages] = useState(false)
  const [selectedMessageIds, setSelectedMessageIds] = useState<string[]>([])
  const [captureImageUrl, setCaptureImageUrl] = useState('')
  const [captureBusy, setCaptureBusy] = useState(false)
  const [appsOpen, setAppsOpen] = useState(false)
  const [stickerPickerOpen, setStickerPickerOpen] = useState(false)
  const [stickerQuery, setStickerQuery] = useState('')
  const [stickerResults, setStickerResults] = useState<RemoteStickerResult[]>([])
  const [stickerBusy, setStickerBusy] = useState(false)
  const [financeMode, setFinanceMode] = useState<'transfer'|'redPacket'|'loan'|null>(null)

  useEffect(() => {
    if (localStorage.getItem(LONG_PRESS_HINT_KEY) === '1') return
    setShowLongPressHint(true)
    const timer = setTimeout(() => {
      localStorage.setItem(LONG_PRESS_HINT_KEY, '1')
      setShowLongPressHint(false)
    }, 6000)
    return () => clearTimeout(timer)
  }, [])

  function dismissLongPressHint() {
    localStorage.setItem(LONG_PRESS_HINT_KEY, '1')
    setShowLongPressHint(false)
  }
  const [financeAmount,setFinanceAmount]=useState('')
  const [financeNote,setFinanceNote]=useState('')
  const [assistBusy, setAssistBusy] = useState(false)
  const isPageMounted = useRef(true)
  const currentConversationRef = useRef<string | undefined>(conversationId)

  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const loadingOlderRef = useRef<{ scrollHeight: number } | null>(null)
  const bubbleRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const [flashId, setFlashId] = useState<string | null>(highlightId)
  const messageById = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages])
  const replyToMessage = replyToId ? messageById.get(replyToId) : undefined
  const menuMessage = menuMessageId ? messageById.get(menuMessageId) : undefined
  const selectedMessages = useMemo(
    () => messages.filter((message) => selectedMessageIds.includes(message.id)),
    [messages, selectedMessageIds],
  )

  const mentionQuery = useMemo(() => {
    if (!isGroupConv) return null
    const match = input.match(/(?:^|\s)@([^\s@]*)$/)
    return match ? match[1].toLowerCase() : null
  }, [input, isGroupConv])

  const mentionCandidates = useMemo(() => {
    if (mentionQuery === null) return []
    return groupMembers
      .filter((member) => displayName(member).toLowerCase().includes(mentionQuery))
      .slice(0, 6)
  }, [groupMembers, mentionQuery])

  // Registers this conversation as "currently open" so background replies
  // don't pop a notification for the chat the user is already looking at.
  useEffect(() => {
    if (!conversationId) return
    setActiveConversation(conversationId)
    return () => setActiveConversation(null)
  }, [conversationId, setActiveConversation])

  useEffect(() => {
    isPageMounted.current = true
    return () => {
      isPageMounted.current = false
    }
  }, [])

  useEffect(() => {
    currentConversationRef.current = conversationId
  }, [conversationId])

  // Marks everything as read whenever this chat is open — runs on mount
  // (clears existing unread) and again each time a new message streams in
  // while the user is still looking at it (keeps it cleared in real time).
  useEffect(() => {
    if (!conversationId || messages.length === 0) return
    db.conversations.update(conversationId, { lastReadAt: Date.now() })
  }, [conversationId, messages.length])

  // useLayoutEffect (not useEffect) so the jump-to-bottom happens before the
  // browser paints — otherwise opening a long conversation briefly flashes
  // the middle/top of the history before snapping to the bottom. `contact`
  // and `group` are in the deps deliberately: `messages` resolves from its
  // own independent useLiveQuery and can settle *before* contact/group does,
  // and the scroll container only actually mounts (guards passed) once
  // contact/group resolves too — without these in the deps, that final
  // unlocking render doesn't re-fire the effect (messages.length already
  // stopped changing by then) and the ref never gets scrolled at all.
  useLayoutEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    if (loadingOlderRef.current) {
      el.scrollTop += el.scrollHeight - loadingOlderRef.current.scrollHeight
      loadingOlderRef.current = null
    } else {
      el.scrollTop = el.scrollHeight
    }
  }, [conversationId, messages.length, latestMessageId, aiTyping, contact, group])

  function loadOlderMessages() {
    const el = scrollContainerRef.current
    if (!el || !hasOlderMessages || loadingOlderRef.current) return
    loadingOlderRef.current = { scrollHeight: el.scrollHeight }
    setVisibleMessageLimit((value) => value + chatPageSize)
  }

  useEffect(() => {
    if (!highlightId || !conversationId) return
    if (!messageById.has(highlightId)) {
      void db.messages.get(highlightId).then(async (target) => {
        if (!target || target.conversationId !== conversationId) return
        const newer = await db.messages.where('[conversationId+createdAt]')
          .above([conversationId, target.createdAt]).count()
        setVisibleMessageLimit((value) => Math.max(value, newer + 1))
      })
      return
    }
    const el = bubbleRefs.current.get(highlightId)
    el?.scrollIntoView({ block: 'center' })
    const t = setTimeout(() => setFlashId(null), 2000)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightId, conversationId, messages.length, messageById])

  async function handleSend() {
    const text = input.trim()
    if (!text || !conversationId) return
    if (isGroupConv) {
      if (!group) return
      const typedMentionIds = groupMembers
        .filter((member) => text.includes(`@${displayName(member)}`))
        .map((member) => member.id)
      const mentionIds = Array.from(new Set([...selectedMentionIds, ...typedMentionIds]))
      setInput('')
      setSelectedMentionIds([])
      setReplyToId(null)
      await sendGroupMessage(conversationId, group, groupMembers, settings, stickers, text, mentionIds, replyToId ?? undefined)
      return
    }
    if (!contact) return
    setInput('')
    await sendMessage(conversationId, contact, settings, stickers, text)
  }

  function insertMention(member: Contact) {
    const name = displayName(member)
    setInput((prev) => {
      const next = prev.replace(/(?:^|\s)@([^\s@]*)$/, (match) => {
        const prefix = match.startsWith(' ') ? ' ' : ''
        return `${prefix}@${name} `
      })
      return next === prev ? `${prev}@${name} ` : next
    })
    setSelectedMentionIds((prev) => Array.from(new Set([...prev, member.id])))
  }

  function labelForMessage(message: Message): string {
    if (message.role === 'user') return settings.userNickname || '我'
    const speaker =
      isGroupConv && message.speakerContactId ? memberById.get(message.speakerContactId) : isGroupConv ? undefined : contact!
    return speaker ? displayName(speaker) : isGroupConv ? group!.name : displayName(contact!)
  }

  function previewForReply(message: Message): string {
    const content = message.type === 'sticker' ? `[表情: ${message.content}]` : message.content
    return `${labelForMessage(message)}: ${content.slice(0, 42)}${content.length > 42 ? '...' : ''}`
  }

  function feedbackContactFor(message: Message): Contact | undefined {
    if (message.role !== 'assistant') return undefined
    if (isGroupConv) return message.speakerContactId ? memberById.get(message.speakerContactId) : undefined
    return contact ?? undefined
  }

  async function copyMessage(message: Message) {
    try {
      await navigator.clipboard?.writeText(message.content)
      setToast('已复制')
    } catch {
      setToast('复制失败')
    }
  }

  async function deleteMessage(message: Message) {
    await db.messages.delete(message.id)
    if (replyToId === message.id) setReplyToId(null)
  }

  async function sendFeedback(message: Message, kind: 'unlike' | 'avoid') {
    if (!conversationId) return
    const target = feedbackContactFor(message)
    if (!target) return
    await applyMessageFeedback({ contact: target, message, kind, conversationId })
    setToast(kind === 'unlike' ? '已记住：这不像TA' : '已记住：以后避开这种说法')
  }

  async function regenerateTurn(message: Message) {
    if (!conversationId || !message.debugAiTurnId) return
    if (isGroupConv) {
      if (!group) return
      await regenerateGroupAiTurn(conversationId, group, groupMembers, settings, stickers, message.debugAiTurnId)
    } else {
      if (!contact) return
      await regenerateAiTurn(conversationId, contact, settings, stickers, message.debugAiTurnId)
    }
    setToast('已重新生成这一轮')
  }

  async function generateAssist() {
    if (!settings.apiKey || assistBusy || !conversationId) return
    const capturedGroup = group
    const capturedContact = contact
    const capturedMentionIds = [...selectedMentionIds]
    const capturedReplyToId = replyToId ?? undefined
    setAssistBusy(true)
    try {
      const draft = await draftReply(settings, messages, capturedContact, capturedGroup)
      if (isPageMounted.current && currentConversationRef.current === conversationId) {
        setInput(draft)
        return
      }
      if (isGroupConv && capturedGroup) {
        await sendGroupMessage(conversationId, capturedGroup, groupMembers, settings, stickers, draft, capturedMentionIds, capturedReplyToId)
      } else if (capturedContact) {
        await sendMessage(conversationId, capturedContact, settings, stickers, draft)
      }
    } catch (e) {
      if (isPageMounted.current) setToast(e instanceof Error ? e.message : String(e))
    } finally {
      if (isPageMounted.current) setAssistBusy(false)
    }
  }

  async function submitFinance() {
    if (!contact || !conversationId || !financeMode) return
    const amount=Math.round(Number(financeAmount)); if(!Number.isFinite(amount)||amount<=0){setToast('请输入有效金额');return}
    try {
      let finance: Message['finance']; let type: Message['type']
      if(financeMode==='loan') { const loanId=uuid(); await db.loans.add({id:loanId,lenderId:contact.id,borrowerId:USER_WALLET_ID,principal:amount,outstanding:amount,note:financeNote,status:'pending',createdAt:Date.now()}); finance={loanId,amount,note:financeNote,status:'pending'};type='loanRequest' }
      else { const tx=await transferFunds({from:USER_WALLET_ID,to:contact.id,amount,kind:financeMode==='transfer'?'transfer':'red_packet',note:financeNote});finance={transactionId:tx.id,amount,note:financeNote,status:financeMode==='transfer'?'completed':'claimed'};type=financeMode }
      await db.messages.add({id:uuid(),conversationId,role:'user',type,content:financeNote||String(amount),finance,createdAt:Date.now()});await db.conversations.update(conversationId,{updatedAt:Date.now()});setFinanceMode(null);setFinanceAmount('');setFinanceNote('');void triggerAiTurn(conversationId,contact,settings,stickers)
    } catch(e){setToast(e instanceof Error?e.message:String(e))}
  }

  async function searchStickers() {
    const query = stickerQuery.trim()
    if (!query) return
    if (!isStickerProviderReady(settings)) {
      setToast('请先在“我 / 表情包管理 / 远程表情包”里完成配置')
      return
    }
    setStickerBusy(true)
    try {
      const results = await searchRemoteStickers(settings, query)
      setStickerResults(results)
      if (results.length === 0) setToast('接口没有返回图片')
    } catch (err) {
      setToast(err instanceof Error ? err.message : String(err))
    } finally {
      setStickerBusy(false)
    }
  }

  async function sendRemoteSticker(result: RemoteStickerResult) {
    if (!conversationId) return
    const name = result.name?.trim() || stickerQuery.trim() || '远程表情'
    await db.messages.add({
      id: uuid(),
      conversationId,
      role: 'user',
      type: 'sticker',
      content: name,
      sticker: { url: result.url, provider: result.provider },
      createdAt: Date.now(),
    })
    await db.conversations.update(conversationId, { updatedAt: Date.now() })
    void trackRemoteStickerSend(result)
    setStickerPickerOpen(false)
    setStickerResults([])
    if (!isGroupConv && contact) void triggerAiTurn(conversationId, contact, settings, stickers)
    else if (isGroupConv && group) void triggerGroupAiTurn(conversationId, group, groupMembers, settings, stickers)
  }
  async function handleFinanceCard(message: Message){
    if(message.type==='redPacket'&&message.role==='assistant'&&message.finance?.transactionId&&message.finance.status==='pending'){try{await claimRedPacket(message.finance.transactionId,USER_WALLET_ID);await db.messages.update(message.id,{finance:{...message.finance,status:'claimed'}});setToast('红包已领取')}catch(e){setToast(e instanceof Error?e.message:String(e))}}
    if(message.type==='loanRequest'&&message.role==='assistant'&&message.finance?.loanId&&message.finance.status==='pending'&&contact){const accept=confirm(`${displayName(contact)}想借 ${message.finance.amount}，是否同意？`);if(accept){try{await transferFunds({from:USER_WALLET_ID,to:contact.id,amount:message.finance.amount,kind:'loan',note:message.finance.note,idempotencyKey:`loan:${message.finance.loanId}`});await db.loans.update(message.finance.loanId,{status:'active',resolvedAt:Date.now()});await db.messages.update(message.id,{finance:{...message.finance,status:'accepted'}})}catch(e){setToast(e instanceof Error?e.message:String(e))}}else{await db.loans.update(message.finance.loanId,{status:'rejected',resolvedAt:Date.now()});await db.messages.update(message.id,{finance:{...message.finance,status:'rejected'}})}}
  }
  async function repayLoan(){if(!contact||!conversationId)return;const loan=await db.loans.filter(l=>l.status==='active'&&l.borrowerId===USER_WALLET_ID&&l.lenderId===contact.id).first();if(!loan){setToast('没有需要归还的借款');return}try{const tx=await transferFunds({from:USER_WALLET_ID,to:contact.id,amount:loan.outstanding,kind:'repayment',note:'归还借款',idempotencyKey:`repay:${loan.id}`});await db.loans.update(loan.id,{status:'repaid',outstanding:0,resolvedAt:Date.now()});await db.messages.add({id:uuid(),conversationId,role:'user',type:'repayment',content:'归还借款',finance:{transactionId:tx.id,loanId:loan.id,amount:loan.outstanding,status:'repaid'},createdAt:Date.now()});void triggerAiTurn(conversationId,contact,settings,stickers)}catch(e){setToast(e instanceof Error?e.message:String(e))}}

  function beginMessageSelection(initialId?: string) {
    setMenuMessageId(null)
    setReplyToId(null)
    setSelectingMessages(true)
    setSelectedMessageIds(initialId ? [initialId] : [])
  }

  function cancelMessageSelection() {
    setSelectingMessages(false)
    setSelectedMessageIds([])
    setCaptureBusy(false)
  }

  function toggleSelectedMessage(id: string) {
    setSelectedMessageIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]))
  }

  async function generateSelectedCapture() {
    if (selectedMessages.length === 0) {
      setToast('先选择要转发的消息')
      return
    }
    setCaptureBusy(true)
    try {
      const imageUrl = await generateChatCaptureImage({
        title: headerTitle,
        messages: selectedMessages,
        user: {
          name: settings.userNickname || '我',
          avatar: settings.userAvatar,
          avatarColor: '#e5f7ef',
        },
        speakerFor: (message) => {
          if (message.role === 'user') {
            return {
              name: settings.userNickname || '我',
              avatar: settings.userAvatar,
              avatarColor: '#e5f7ef',
            }
          }
          if (isGroupConv) {
            const speaker = message.speakerContactId ? memberById.get(message.speakerContactId) : undefined
            return {
              name: speaker ? displayName(speaker) : group!.name,
              avatar: speaker?.avatar ?? group!.avatar,
              avatarColor: speaker?.avatarColor ?? group!.avatarColor,
            }
          }
          return {
            name: displayName(contact!),
            avatar: contact!.avatar,
            avatarColor: contact!.avatarColor,
          }
        },
      })
      setCaptureImageUrl(imageUrl)
    } catch (err) {
      setToast(err instanceof Error ? err.message : '生成截图失败')
    } finally {
      setCaptureBusy(false)
    }
  }

  async function shareCaptureImage() {
    if (!captureImageUrl) return
    try {
      const shared = await shareDataUrl(captureImageUrl, `talk-chat-${Date.now()}.png`)
      if (!shared) {
        downloadDataUrl(captureImageUrl, `talk-chat-${Date.now()}.png`)
        setToast('已保存图片')
      }
    } catch {
      setToast('分享失败')
    }
  }

  if (conversation === undefined) return null
  if (conversation === null) {
    return (
      <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[#ededed]">
        <TopBar title="对话" showBack />
        <p className="px-4 py-10 text-center text-sm text-gray-400">会话不存在</p>
      </div>
    )
  }
  if (isGroupConv) {
    if (group === undefined) return null
    if (group === null) {
      return (
        <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[#ededed]">
          <TopBar title="群聊" showBack />
          <p className="px-4 py-10 text-center text-sm text-gray-400">该群聊已被解散</p>
        </div>
      )
    }
  } else {
    if (contact === undefined) return null
    if (contact === null) {
      return (
        <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[#ededed]">
          <TopBar title="对话" showBack />
          <p className="px-4 py-10 text-center text-sm text-gray-400">会话不存在</p>
        </div>
      )
    }
  }

  const headerTitle = isGroupConv ? group!.name : displayName(contact!)
  const visibleHeaderTitle = aiTyping && typingLabel ? `${typingLabel}正在输入中...` : headerTitle
  const headerInfoPath = isGroupConv ? `/group/${group!.id}` : `/contact/${contact!.id}`
  const chatBackgroundStyle =
    settings.chatBackground && settings.chatBackground.startsWith('data:')
      ? { backgroundImage: `url(${settings.chatBackground})`, backgroundSize: 'cover', backgroundPosition: 'center' }
      : settings.chatBackground
        ? { backgroundColor: settings.chatBackground }
        : undefined

  return (
    <div className="relative flex h-[var(--app-height)] flex-col overflow-hidden bg-[#ededed]">
      <TopBar
        title={selectingMessages ? `已选择 ${selectedMessageIds.length} 条` : visibleHeaderTitle}
        showBack={!selectingMessages}
        showSearch={!selectingMessages}
        onSearchClick={() => setSearching(true)}
        right={
          selectingMessages ? (
            <button onClick={cancelMessageSelection} className="px-2 text-sm text-gray-600">
              取消
            </button>
          ) : (
            <>
              <button
                onClick={() => beginMessageSelection()}
                disabled={messages.length === 0}
                className="flex h-9 items-center px-1.5 text-sm text-gray-600 disabled:text-gray-300"
              >
                选择
              </button>
              <button
                onClick={() => navigate(headerInfoPath)}
                className="flex h-9 w-9 items-center justify-center text-gray-500"
                aria-label={isGroupConv ? '群聊信息' : '联系人名片'}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M12 11v5M12 8v.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            </>
          )
        }
      />
      {statusLine && (
        <button
          onClick={() => navigate(headerInfoPath)}
          className="shrink-0 border-b border-gray-100 bg-white px-4 py-1.5 text-center text-[11px] text-gray-400"
        >
          <span className="block truncate">{statusLine}</span>
        </button>
      )}
      {showLongPressHint && (
        <div data-testid="long-press-hint" className="flex shrink-0 items-center gap-2 border-b border-purple-100 bg-purple-50 px-4 py-2 text-[11px] text-purple-700">
          <span className="min-w-0 flex-1">提示：长按消息可以重新生成、反馈、复制或删除。</span>
          <button type="button" onClick={dismissLongPressHint} className="shrink-0 rounded px-1.5 py-1 text-purple-500">知道了</button>
        </div>
      )}

      <div
        ref={scrollContainerRef}
        data-testid="chat-scroll"
        className="flex-1 overflow-y-auto pt-2"
        style={chatBackgroundStyle}
        onScroll={(event) => { if (event.currentTarget.scrollTop < 80) loadOlderMessages() }}
      >
        {hasOlderMessages && (
          <div className="flex justify-center py-2">
            <button onClick={loadOlderMessages} className="rounded-full bg-white/90 px-3 py-1 text-xs text-gray-500 shadow-sm">加载更早消息</button>
          </div>
        )}
        {messages.map((m, index) => {
          const speaker =
            isGroupConv && m.role === 'assistant' && m.speakerContactId ? memberById.get(m.speakerContactId) : undefined
          const bubbleName = isGroupConv ? (speaker ? displayName(speaker) : group!.name) : displayName(contact!)
          const bubbleAvatar = isGroupConv ? (speaker ? speaker.avatar : group!.avatar) : contact!.avatar
          const bubbleAvatarColor = isGroupConv ? (speaker ? speaker.avatarColor : group!.avatarColor) : contact!.avatarColor
          const previousMessage = messages[index - 1]
          const showConversationTime = !previousMessage || m.createdAt - previousMessage.createdAt > 10 * 60 * 1000
          const msgBubble = (
            <div className="animate-[message-in_180ms_ease-out]">
              {showConversationTime && <p className="my-4 text-center text-[11px] text-gray-400">{new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>}
              <MessageBubble
              ref={(el) => {
                if (el) bubbleRefs.current.set(m.id, el)
              }}
              message={m}
              contactName={bubbleName}
              contactAvatar={bubbleAvatar}
              contactAvatarColor={bubbleAvatarColor}
              userAvatar={settings.userAvatar}
              stickerUrl={m.type === 'sticker' ? (m.sticker?.url ?? stickerByName.get(m.content)) : undefined}
              mentionNames={(m.mentions ?? []).map((id) => memberById.get(id)).filter((c): c is Contact => !!c).map(displayName)}
              replyPreview={m.replyToMessageId ? previewForReply(messageById.get(m.replyToMessageId) ?? m) : undefined}
              highlighted={flashId === m.id}
              selecting={selectingMessages}
              selected={selectedMessageIds.includes(m.id)}
              onSelect={() => toggleSelectedMessage(m.id)}
              onReply={!selectingMessages && isGroupConv ? () => setReplyToId(m.id) : undefined}
              onLongPress={() => setMenuMessageId(m.id)}
              onLinkClick={selectingMessages ? undefined : () => { const routes:Record<string,string>={work:'/work',shop:'/shop',warehouse:'/warehouse'}; const path=m.link?.app?routes[m.link.app]:undefined; if(path)navigate(path);else setToast('暂不支持这个小程序') }}
              onFinanceClick={selectingMessages ? undefined : handleFinanceCard}
              showName={isGroupConv && m.role === 'assistant'}
              />
            </div>
          )
          const showThought = mindReadingEnabled && m.thought && m.role === 'assistant'
          if (showThought) {
            return (
              <div key={`thought-${m.id}`}>
                {msgBubble}
                <div className="flex justify-start px-3">
                  <div className="ml-10 max-w-[85%]">
                    <div className="rounded-2xl rounded-tl-md border border-purple-200 bg-purple-50 px-3.5 py-2">
                      <p className="text-[11px] leading-relaxed text-purple-600">
                        <span className="font-medium">🔮 </span>
                        {m.thought}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            )
          }
          return <div key={`message-${m.id}`}>{msgBubble}</div>
        })}
      </div>

      {error && <p className="bg-red-50 px-4 py-1.5 text-xs text-red-500">{error}</p>}
      {toast && (
        <p className="bg-gray-100 px-4 py-1.5 text-center text-xs text-gray-500" onAnimationEnd={() => setToast('')}>
          {toast}
        </p>
      )}

      <div className="shrink-0 border-t border-gray-200 bg-white p-2 pb-[env(safe-area-inset-bottom)]">
        {selectingMessages ? (
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                if (selectedMessageIds.length === messages.length) setSelectedMessageIds([])
                else setSelectedMessageIds(messages.map((message) => message.id))
              }}
              className="rounded-xl bg-gray-100 px-3 py-2 text-sm text-gray-700"
            >
              {selectedMessageIds.length === messages.length ? '全不选' : '全选'}
            </button>
            <button
              onClick={generateSelectedCapture}
              disabled={selectedMessageIds.length === 0 || captureBusy}
              className="flex-1 rounded-xl bg-gray-900 px-4 py-2 text-sm text-white disabled:opacity-40"
            >
              {captureBusy ? '生成中…' : `生成截图 (${selectedMessageIds.length})`}
            </button>
          </div>
        ) : (
          <>
            {replyToMessage && (
              <div className="mb-2 flex items-center gap-2 rounded-lg bg-gray-50 px-2.5 py-1.5 text-xs text-gray-500">
                <span className="min-w-0 flex-1 truncate">回复 {previewForReply(replyToMessage)}</span>
                <button onClick={() => setReplyToId(null)} className="shrink-0 text-gray-400">
                  取消
                </button>
              </div>
            )}
            {mentionCandidates.length > 0 && (
              <div className="mb-2 max-h-44 overflow-y-auto rounded-xl border border-gray-100 bg-white shadow-sm">
                {mentionCandidates.map((member) => (
                  <button
                    key={member.id}
                    onClick={() => insertMention(member)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left active:bg-gray-50"
                  >
                    <span className="text-sm text-gray-800">@{displayName(member)}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="flex items-end gap-2">
              <button onClick={()=>setAppsOpen(true)} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gray-100 text-2xl text-gray-600">＋</button>
              {replyAssistEnabled && <button type="button" onClick={() => void generateAssist()} disabled={assistBusy} aria-label="AI代写" aria-busy={assistBusy} className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg transition duration-150 active:scale-90 disabled:cursor-wait ${assistBusy ? 'animate-pulse bg-purple-600 text-white shadow-inner' : 'bg-purple-100 text-purple-600 active:bg-purple-200'}`}>{assistBusy ? '✦' : '✨'}</button>}
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (!assistBusy && e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    handleSend()
                  }
                }}
                disabled={assistBusy}
                placeholder={assistBusy ? 'AI代写中...' : aiTyping ? '对方正在输入 你可以直接插话打断' : '发消息…'}
                rows={1}
                className="max-h-24 flex-1 resize-none rounded-xl border border-gray-200 px-3 py-2 text-[14.5px] outline-none disabled:cursor-wait disabled:bg-gray-50 disabled:text-gray-400"
              />
              <button
                onClick={handleSend}
                disabled={assistBusy || !input.trim()}
                className="shrink-0 rounded-xl bg-gray-900 px-4 py-2 text-sm text-white disabled:opacity-40"
              >
                发送
              </button>
            </div>
          </>
        )}
      </div>
      {searching && <SearchOverlay onClose={() => setSearching(false)} />}
      {captureImageUrl && (
        <div className="absolute inset-0 z-40 flex flex-col bg-black/55 p-4">
          <div className="mt-6 min-h-0 flex-1 overflow-y-auto rounded-xl bg-white p-2">
            <img src={captureImageUrl} alt="聊天记录截图预览" className="w-full rounded-lg" />
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <button
              onClick={() => {
                downloadDataUrl(captureImageUrl, `talk-chat-${Date.now()}.png`)
                setToast('已保存图片')
              }}
              className="rounded-xl bg-white py-2.5 text-sm text-gray-900"
            >
              保存图片
            </button>
            <button onClick={shareCaptureImage} className="rounded-xl bg-white py-2.5 text-sm text-gray-900">
              分享
            </button>
            <button
              onClick={() => {
                setCaptureImageUrl('')
                cancelMessageSelection()
              }}
              className="rounded-xl bg-gray-900 py-2.5 text-sm text-white"
            >
              完成
            </button>
          </div>
        </div>
      )}
      {menuMessage && (
        <ActionSheet
          onClose={() => setMenuMessageId(null)}
          options={[
            { label: '复制', onSelect: () => void copyMessage(menuMessage) },
            { label: '选择转发截图', onSelect: () => beginMessageSelection(menuMessage.id) },
            ...(feedbackContactFor(menuMessage)
              ? [
                  ...(menuMessage.debugAiTurnId
                    ? [{ label: '重新生成这一轮', onSelect: () => void regenerateTurn(menuMessage) }]
                    : []),
                  { label: '这不像TA', onSelect: () => void sendFeedback(menuMessage, 'unlike') },
                  { label: '以后别这样说', onSelect: () => void sendFeedback(menuMessage, 'avoid') },
                ]
              : []),
            ...(isGroupConv ? [{ label: '回复', onSelect: () => setReplyToId(menuMessage.id) }] : []),
            { label: '删除这条消息', onSelect: () => void deleteMessage(menuMessage), danger: true },
          ]}
        />
      )}
      {stickerPickerOpen && (
        <div className="absolute inset-0 z-50 flex items-end bg-black/30" onClick={() => setStickerPickerOpen(false)}>
          <div className="flex max-h-[78%] w-full flex-col rounded-t-2xl bg-white pb-[env(safe-area-inset-bottom)]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 border-b border-gray-100 p-3">
              <input autoFocus value={stickerQuery} onChange={(e) => setStickerQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void searchStickers() }} placeholder="搜一个表情包，例如：猫猫、无语" className="min-w-0 flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm" />
              <button type="button" onClick={() => void searchStickers()} disabled={stickerBusy} className="rounded-lg bg-gray-900 px-3 py-2 text-sm text-white disabled:opacity-40">{stickerBusy ? '搜索中' : '搜索'}</button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {stickerResults.length === 0 ? <p className="py-8 text-center text-xs text-gray-400">输入关键词后搜索，点图片即可发送</p> : <div className="grid grid-cols-3 gap-2">{stickerResults.map((result, index) => <button key={`${result.url}-${index}`} type="button" onClick={() => void sendRemoteSticker(result)} className="aspect-square overflow-hidden rounded-xl bg-gray-100"><img src={result.url} alt={result.name || stickerQuery} loading="lazy" className="h-full w-full object-cover" /></button>)}</div>}
              {settings.stickerProvider !== 'none' && <p className="mt-3 text-center text-[10px] text-gray-400">Powered by {stickerProviderName(settings.stickerProvider)}</p>}
            </div>
          </div>
        </div>
      )}
      {appsOpen && (
        <ActionSheet onClose={()=>setAppsOpen(false)} options={[
          {label:'搜索远程表情包',onSelect:()=>{setAppsOpen(false);setStickerPickerOpen(true);setStickerQuery('');setStickerResults([])}},
          ...(!isGroupConv&&careerEnabled?[{label:'💸 转账',onSelect:()=>{setAppsOpen(false);setFinanceMode('transfer' as const)}},{label:'🧧 红包',onSelect:()=>{setAppsOpen(false);setFinanceMode('redPacket' as const)}},{label:'🤝 借款',onSelect:()=>{setAppsOpen(false);setFinanceMode('loan' as const)}},{label:'💰 归还借款',onSelect:()=>{setAppsOpen(false);void repayLoan()}}]:[]),
          {label:'💼 工作',onSelect:()=>navigate('/work')},{label:'🛍️ 商城',onSelect:()=>navigate('/shop')},{label:'🎒 仓库',onSelect:()=>navigate('/warehouse')}
        ]}/>
      )}
      {financeMode&&<div className="absolute inset-0 z-50 flex items-end bg-black/30" onClick={()=>setFinanceMode(null)}><div className="w-full rounded-t-2xl bg-white p-4" onClick={e=>e.stopPropagation()}><h3 className="font-medium">{financeMode==='transfer'?'转账':financeMode==='redPacket'?'发红包':'向TA借款'}</h3><input type="number" min="1" value={financeAmount} onChange={e=>setFinanceAmount(e.target.value)} placeholder="金额" className="mt-3 w-full rounded-lg border px-3 py-2"/><input value={financeNote} onChange={e=>setFinanceNote(e.target.value)} placeholder="备注或借款理由" className="mt-2 w-full rounded-lg border px-3 py-2"/><button onClick={submitFinance} className="mt-3 w-full rounded-lg bg-gray-900 py-2.5 text-white">确认</button></div></div>}
    </div>
  )
}
