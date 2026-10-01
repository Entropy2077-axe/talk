import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import Dexie from 'dexie'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { ChatComposer } from '../components/ChatComposer'
import { MessageBubble } from '../components/MessageBubble'
import { SearchOverlay } from '../components/SearchOverlay'
import { ActionSheet } from '../components/ActionSheet'
import { useSettingsStore } from '../store/useSettingsStore'
import { useModuleEnabled } from '../features'
import { useChatUiStore } from '../store/useChatUiStore'
import { DEFAULT_RUNTIME_STATE, nextMessageTimestamp, regenerateAiTurn, sendMessage, stopAiTurn, triggerAiTurn, useChatEngineStore } from '../lib/chatEngine'
import { regenerateGroupAiTurn, sendGroupMessage, stopGroupAiTurn, triggerGroupAiTurn } from '../lib/groupChatEngine'
import { displayName } from '../lib/contact'
import { applyMessageFeedback } from '../lib/messageFeedback'
import { buildPrivateStatusLine } from '../lib/contactStatus'
import { downloadDataUrl, generateChatCaptureImage, shareDataUrl } from '../lib/chatCapture'
import type { Contact, Message, SpeechCacheRecord, Sticker } from '../types'
import { v4 as uuid } from 'uuid'
import { claimRedPacket, transferFunds, USER_WALLET_ID } from '../lib/finance'
import { searchRemoteStickers, trackRemoteStickerSend, type RemoteStickerResult } from '../lib/remoteMedia'
import { isStickerProviderReady, stickerProviderName } from '../lib/mediaProviders'
import { normalizeChatPageSize } from '../lib/chatPagination'
import { resolveLocationParticipants, syncContactLocationsAt } from '../lib/locations'
import { revertInternalTask } from '../lib/internalTasks'
import { ArrowLeftRight, BriefcaseBusiness, CircleDollarSign, Gift, HandCoins, Package, Plus, ShoppingBag, Sticker as StickerIcon } from 'lucide-react'
import { UiIcon } from '../components/UiIcon'
import { isAiTestId } from '../lib/aiTestIsolation'
import { contactSpeechVoice, isSpeechProviderReady } from '../lib/speechProviders'
import { cacheSpeechForMessage, speechSignature } from '../lib/speechSynthesis'
import { playSpeechMessage, playSpeechRecord, stopSpeechPlayback, useSpeechPlayerStore } from '../lib/speechPlayer'
import { acceptContactRecommendation, declineContactRecommendation, recommendationFromMessage } from '../lib/contactRecommendations'

const EMPTY_CONTACTS: Contact[] = []
const EMPTY_MESSAGES: Message[] = []
const EMPTY_STICKERS: Sticker[] = []
const EMPTY_SPEECH_CACHE_ROWS: Array<SpeechCacheRecord | undefined> = []
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
  const relationshipEnabled = useModuleEnabled('relationship')
  const locationEnabled = useModuleEnabled('location')
  const shopEnabled = useModuleEnabled('shop')
  const warehouseEnabled = useModuleEnabled('warehouse')
  const speechEnabled = useModuleEnabled('speech')
  const desktop = Boolean(window.talkDesktop)
  const hiddenTestConversation = isAiTestId(conversationId)
  useEffect(() => {
    if (hiddenTestConversation) void navigate('/ai-test-cards', { replace: true })
  }, [hiddenTestConversation, navigate])

  const conversation = useLiveQuery(
    () => (conversationId ? db.conversations.get(conversationId) : undefined),
    [conversationId],
  )
  const isGroupConv = !!conversation?.groupId
  const contact = useLiveQuery(
    () => (conversation && !conversation.groupId ? db.contacts.get(conversation.contactId!) : undefined),
    [conversation?.contactId, conversation?.groupId],
  )
  const group = useLiveQuery(
    () => (conversation?.groupId ? db.groups.get(conversation.groupId) : undefined),
    [conversation?.groupId],
  )
  const groupLocation = useLiveQuery(
    () => (group?.kind === 'location' && group.locationId ? db.locations.get(group.locationId) : undefined),
    [group?.kind, group?.locationId],
  )
  useEffect(() => {
    if (group?.kind !== 'location' || !group.locationId) return
    let cancelled = false
    void (async () => {
      await syncContactLocationsAt(new Date())
      const participants = await resolveLocationParticipants(group.locationId!)
      if (!cancelled) await db.groups.update(group.id, { memberContactIds: participants.activeMembers.map((contact) => contact.id) })
    })()
    return () => { cancelled = true }
  }, [group?.id, group?.kind, group?.locationId])
  const memberIdsKey = JSON.stringify(group?.memberContactIds ?? [])
  const groupMembersRaw = useLiveQuery(
    () => (group ? db.contacts.bulkGet(group.memberContactIds) : []),
    [memberIdsKey],
  )
  const groupMembers = useMemo(() => (groupMembersRaw ?? []).filter((c): c is Contact => !!c), [groupMembersRaw])
  const memberById = useMemo(() => new Map(groupMembers.map((c) => [c.id, c])), [groupMembers])

  const [visibleMessageLimit, setVisibleMessageLimit] = useState(chatPageSize)
  const nearBottomRef = useRef(true)
  const retainedHistoryRef = useRef<{ conversationId: string; createdAt: number } | null>(null)
  useEffect(() => setVisibleMessageLimit(chatPageSize), [conversationId, chatPageSize])
  const messagePage = useLiveQuery(async () => {
    if (!conversationId) return { items: EMPTY_MESSAGES, total: 0 }
    const range = () => db.messages
      .where('[conversationId+createdAt]')
      .between([conversationId, Dexie.minKey], [conversationId, Dexie.maxKey], true, true)
    // New replies must not push the oldest visible message out of a reader's window.
    const retainedStart = !nearBottomRef.current && retainedHistoryRef.current?.conversationId === conversationId ? retainedHistoryRef.current.createdAt : undefined
    const retainedCount = retainedStart === undefined ? 0 : await db.messages.where('[conversationId+createdAt]')
      .between([conversationId, retainedStart], [conversationId, Dexie.maxKey], true, true).count()
    const [newestFirst, total] = await Promise.all([
      range().reverse().limit(Math.max(visibleMessageLimit, retainedCount)).toArray(),
      range().count(),
    ])
    return { items: newestFirst.reverse(), total }
  }, [conversationId, visibleMessageLimit])
  const messages = messagePage?.items ?? EMPTY_MESSAGES
  const textMessageIdsKey = messages.filter((message) => message.type === 'text').map((message) => message.id).join('|')
  const speechCacheRows = useLiveQuery(
    () => speechEnabled && textMessageIdsKey ? db.speechCache.bulkGet(textMessageIdsKey.split('|')) : [],
    [speechEnabled, textMessageIdsKey],
  ) ?? EMPTY_SPEECH_CACHE_ROWS
  const speechCacheByMessage = useMemo(
    () => new Map(speechCacheRows.filter((row) => !!row).map((row) => [row!.messageId, row!])),
    [speechCacheRows],
  )
  const latestMessageId = messages.at(-1)?.id
  const latestMessageAt = messages.at(-1)?.createdAt ?? 0
  const messagesReady = Boolean(messagePage)
  const contentReady = isGroupConv ? Boolean(group) : Boolean(contact)
  const hasOlderMessages = messages.length < (messagePage?.total ?? 0)
  const stickers = useLiveQuery(() => db.stickers.toArray(), []) ?? EMPTY_STICKERS
  const stickerByName = useMemo(() => new Map(stickers.map((s) => [s.name, s.dataUrl])), [stickers])
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
    void buildPrivateStatusLine(contact).then((text) => {
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

  const [toast, setToast] = useState('')
  const [showLongPressHint, setShowLongPressHint] = useState(false)
  const [searching, setSearching] = useState(false)
  const [replyToId, setReplyToId] = useState<string | null>(null)
  const [menuMessageId, setMenuMessageId] = useState<string | null>(null)

  function handleStopGeneration() {
    if (!conversationId) return
    if (isGroupConv) stopGroupAiTurn(conversationId)
    else stopAiTurn(conversationId)
    setToast('已停止生成')
  }
  const [regenerationMessageId, setRegenerationMessageId] = useState<string | null>(null)
  const [regenerationInstruction, setRegenerationInstruction] = useState('')
  const [selectingMessages, setSelectingMessages] = useState(false)
  const [selectedMessageIds, setSelectedMessageIds] = useState<string[]>([])
  const [captureImageUrl, setCaptureImageUrl] = useState('')
  const [captureBusy, setCaptureBusy] = useState(false)
  const [appsOpen, setAppsOpen] = useState(false)
  const [stickerPickerOpen, setStickerPickerOpen] = useState(false)
  function openStickers() { setStickerPickerOpen(true); setStickerQuery(''); setStickerResults([]) }
  const [stickerQuery, setStickerQuery] = useState('')
  const [stickerResults, setStickerResults] = useState<RemoteStickerResult[]>([])
  const [stickerBusy, setStickerBusy] = useState(false)
  const [financeMode, setFinanceMode] = useState<'transfer'|'redPacket'|'loan'|null>(null)
  const [generatingSpeechIds, setGeneratingSpeechIds] = useState<Set<string>>(() => new Set())
  const speechPlayingId = useSpeechPlayerStore((state) => state.messageId)
  const speechPlaying = useSpeechPlayerStore((state) => state.playing)

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

  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const messageContentRef = useRef<HTMLDivElement>(null)
  const initializedScrollRef = useRef<string | undefined>(undefined)
  const highlightedScrollRef = useRef('')
  const readingAnchorRef = useRef<{ id: string; offset: number } | null>(null)
  const [awayFromLatest, setAwayFromLatest] = useState(false)
  const loadingOlderRef = useRef<{ scrollHeight: number } | null>(null)
  const bubbleRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const [flashId, setFlashId] = useState<string | null>(highlightId)
  const messageById = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages])
  const replyToMessage = replyToId ? messageById.get(replyToId) : undefined
  const menuMessage = menuMessageId ? messageById.get(menuMessageId) : undefined
  const menuSpeechContact = menuMessage?.role === 'assistant'
    ? (isGroupConv ? (menuMessage.speakerContactId ? memberById.get(menuMessage.speakerContactId) : undefined) : contact ?? undefined)
    : undefined
  const menuSpeechVoice = speechEnabled ? contactSpeechVoice(menuSpeechContact, settings.speechProvider) : undefined
  const regenerationMessage = regenerationMessageId ? messageById.get(regenerationMessageId) : undefined
  const latestRegeneratableMessage = [...messages].reverse().find((message) => message.role === 'assistant' && message.debugAiTurnId && message.image?.presentation !== 'illustration')
  const selectedMessages = useMemo(
    () => messages.filter((message) => selectedMessageIds.includes(message.id)),
    [messages, selectedMessageIds],
  )

  // Registers this conversation as "currently open" so background replies
  // don't pop a notification for the chat the user is already looking at.
  useEffect(() => {
    if (!conversationId) return
    setActiveConversation(conversationId)
    return () => setActiveConversation(null)
  }, [conversationId, setActiveConversation])

  // Marks everything as read whenever this chat is open — runs on mount
  // (clears existing unread) and again each time a new message streams in
  // while the user is still looking at it (keeps it cleared in real time).
  useEffect(() => {
    if (!conversationId || !latestMessageId) return
    void db.conversations.update(conversationId, { lastReadAt: Math.max(Date.now(), latestMessageAt) })
  }, [conversationId, latestMessageId, latestMessageAt])

  useEffect(() => {
    if (!speechEnabled) stopSpeechPlayback()
  }, [speechEnabled])

  function jumpToLatest() {
    nearBottomRef.current = true
    readingAnchorRef.current = null
    setAwayFromLatest(false)
    const el = scrollContainerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  function rememberReadingPosition() {
    const el = scrollContainerRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    nearBottomRef.current = nearBottom
    setAwayFromLatest(!nearBottom)
    const top = el.getBoundingClientRect().top
    const visible = Array.from(bubbleRefs.current.entries()).find(([, node]) => node.getBoundingClientRect().bottom > top)
    readingAnchorRef.current = !nearBottom && visible ? { id: visible[0], offset: visible[1].getBoundingClientRect().top - top } : null
  }

  // Initialize before paint; subsequent updates follow only readers already at the bottom.
  useLayoutEffect(() => {
    const el = scrollContainerRef.current
    if (!el || !messagesReady) return
    retainedHistoryRef.current = messages[0] && conversationId ? { conversationId, createdAt: messages[0].createdAt } : null
    if (initializedScrollRef.current !== conversationId) {
      initializedScrollRef.current = conversationId
      loadingOlderRef.current = null
      readingAnchorRef.current = null
      nearBottomRef.current = !highlightId
      setAwayFromLatest(Boolean(highlightId))
      if (!highlightId) el.scrollTop = el.scrollHeight
    } else if (loadingOlderRef.current) {
      el.scrollTop += el.scrollHeight - loadingOlderRef.current.scrollHeight
      loadingOlderRef.current = null
    } else if (nearBottomRef.current) {
      el.scrollTop = el.scrollHeight
    } else if (readingAnchorRef.current) {
      const anchor = bubbleRefs.current.get(readingAnchorRef.current.id)
      if (anchor) el.scrollTop += anchor.getBoundingClientRect().top - el.getBoundingClientRect().top - readingAnchorRef.current.offset
    }
  }, [conversationId, messages, aiTyping, contentReady, messagesReady, highlightId])

  useEffect(() => {
    const el = scrollContainerRef.current
    const content = messageContentRef.current
    if (!el || !content || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (nearBottomRef.current) el.scrollTop = el.scrollHeight
      else if (readingAnchorRef.current) {
        const anchor = bubbleRefs.current.get(readingAnchorRef.current.id)
        if (anchor) el.scrollTop += anchor.getBoundingClientRect().top - el.getBoundingClientRect().top - readingAnchorRef.current.offset
      }
    })
    observer.observe(el)
    observer.observe(content)
    return () => observer.disconnect()
  }, [conversationId, contentReady])

  function loadOlderMessages() {
    const el = scrollContainerRef.current
    if (!el || !hasOlderMessages || loadingOlderRef.current) return
    loadingOlderRef.current = { scrollHeight: el.scrollHeight }
    setVisibleMessageLimit((value) => Math.max(value, messages.length) + chatPageSize)
  }

  useEffect(() => {
    if (!highlightId || !conversationId) return
    const key = `${conversationId}:${highlightId}`
    if (highlightedScrollRef.current === key) return
    let cancelled = false
    if (!messageById.has(highlightId)) {
      void db.messages.get(highlightId).then(async (target) => {
        if (cancelled || !target || target.conversationId !== conversationId) return
        const newer = await db.messages.where('[conversationId+createdAt]')
          .above([conversationId, target.createdAt]).count()
        if (!cancelled) setVisibleMessageLimit((value) => Math.max(value, newer + 1))
      })
      return () => { cancelled = true }
    }
    const el = bubbleRefs.current.get(highlightId)
    if (!el) return
    el?.scrollIntoView({ block: 'center' })
    highlightedScrollRef.current = key
    setFlashId(highlightId)
    rememberReadingPosition()
    const t = setTimeout(() => setFlashId(null), 2000)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightId, conversationId, messages.length, messageById, contentReady])

  async function handleSend(text: string, mentionIds: string[]): Promise<boolean> {
    if (!conversationId) return false
    const currentSettings = useSettingsStore.getState()
    try {
      const sent = isGroupConv
        ? !!group && await sendGroupMessage(conversationId, group, groupMembers, currentSettings, stickers, text, mentionIds, replyToId ?? undefined)
        : !!contact && await sendMessage(conversationId, contact, currentSettings, stickers, text)
      if (sent && useChatUiStore.getState().activeConversationId === conversationId) {
        setReplyToId((value) => value === replyToId ? null : value)
        jumpToLatest()
      }
      return sent
    } catch (error) {
      useChatEngineStore.getState().patch(conversationId, { error: '消息未发送，输入已保留：' + (error instanceof Error ? error.message : String(error)) })
      return false
    }
  }

  function retryCurrentTurn() {
    if (!conversationId || aiTyping) return
    if (isGroupConv) {
      if (group) void triggerGroupAiTurn(conversationId, group, groupMembers, settings, stickers)
      return
    }
    if (contact) void triggerAiTurn(conversationId, contact, settings, stickers)
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
    if (message.role !== 'assistant' || message.image?.presentation === 'illustration') return undefined
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
    if (speechPlayingId === message.id) stopSpeechPlayback()
    await db.transaction('rw', db.messages, db.speechCache, db.mediaAssets, async () => {
      await db.messages.delete(message.id)
      await db.speechCache.delete(message.id)
      if (message.image?.assetId) await db.mediaAssets.delete(message.image.assetId)
    })
    if (replyToId === message.id) setReplyToId(null)
  }

  async function generateMessageSpeech(message: Message, force = false) {
    if (!speechEnabled) return
    if (message.type !== 'text' || message.role !== 'assistant') return
    const currentSettings = useSettingsStore.getState()
    if (!isSpeechProviderReady(currentSettings)) {
      setToast('请先配置语音生成服务')
      void navigate('/settings/speech-generation')
      return
    }
    const speaker = isGroupConv
      ? (message.speakerContactId ? memberById.get(message.speakerContactId) : undefined)
      : contact ?? undefined
    const voice = contactSpeechVoice(speaker, currentSettings.speechProvider)
    if (!speaker || !voice) {
      setToast(`还没有为${speaker ? displayName(speaker) : '这位联系人'}匹配当前服务的音色，请先去联系人名片设置`)
      if (speaker) void navigate(`/contact/${speaker.id}`)
      return
    }
    setGeneratingSpeechIds((current) => new Set(current).add(message.id))
    try {
      const record = await cacheSpeechForMessage(message.id, message.content, currentSettings, force, voice)
      await playSpeechRecord(record)
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error))
    } finally {
      setGeneratingSpeechIds((current) => {
        const next = new Set(current)
        next.delete(message.id)
        return next
      })
    }
  }

  async function generateReplyRoundSpeech(anchor: Message) {
    if (!speechEnabled) return
    if (!conversationId || anchor.role !== 'assistant') return
    const currentSettings = useSettingsStore.getState()
    if (!isSpeechProviderReady(currentSettings)) {
      setToast('请先配置语音生成服务')
      void navigate('/settings/speech-generation')
      return
    }
    const conversationMessages = (await db.messages.where('conversationId').equals(conversationId).toArray())
      .sort((a, b) => a.createdAt - b.createdAt)
    let roundMessages = anchor.debugAiTurnId
      ? conversationMessages.filter((message) => message.debugAiTurnId === anchor.debugAiTurnId)
      : anchor.bubbleGroupId
        ? conversationMessages.filter((message) => message.bubbleGroupId === anchor.bubbleGroupId)
        : []
    // Older messages may not have a turn id. In that case, the assistant
    // messages between the surrounding user messages are one reply round.
    if (roundMessages.length === 0) {
      const anchorIndex = conversationMessages.findIndex((message) => message.id === anchor.id)
      if (anchorIndex >= 0) {
        let start = anchorIndex
        let end = anchorIndex
        while (start > 0 && conversationMessages[start - 1]?.role === 'assistant') start -= 1
        while (end + 1 < conversationMessages.length && conversationMessages[end + 1]?.role === 'assistant') end += 1
        roundMessages = conversationMessages.slice(start, end + 1)
      }
    }
    const textMessages = roundMessages.filter((message) => message.role === 'assistant' && message.type === 'text' && message.content.trim())
    if (textMessages.length === 0) {
      setToast('这一轮没有可生成语音的文字消息')
      return
    }
    const items = textMessages.map((message) => {
      const speaker = isGroupConv
        ? (message.speakerContactId ? memberById.get(message.speakerContactId) : undefined)
        : contact ?? undefined
      return { message, speaker, voice: contactSpeechVoice(speaker, currentSettings.speechProvider) }
    })
    const missingSpeakers = Array.from(new Map(items.filter((item) => !item.voice && item.speaker).map((item) => [item.speaker!.id, item.speaker!])).values())
    const unresolvedSpeaker = items.some((item) => !item.speaker)
    if (missingSpeakers.length > 0 || unresolvedSpeaker) {
      const names = missingSpeakers.map(displayName).join('、') || '本轮联系人'
      setToast(`${names}还没有匹配当前服务的音色，请先去联系人名片设置`)
      if (missingSpeakers[0]) void navigate(`/contact/${missingSpeakers[0].id}`)
      return
    }
    const ids = new Set(textMessages.map((message) => message.id))
    setGeneratingSpeechIds((current) => new Set([...current, ...ids]))
    try {
      for (const item of items) {
        await cacheSpeechForMessage(item.message.id, item.message.content, currentSettings, false, item.voice!)
      }
      setToast(`已生成这一轮的 ${items.length} 条语音`)
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error))
    } finally {
      setGeneratingSpeechIds((current) => {
        const next = new Set(current)
        ids.forEach((id) => next.delete(id))
        return next
      })
    }
  }

  const handleSpeechClick = useCallback((message: Message) => {
    void playSpeechMessage(message.id).catch((error) => setToast(error instanceof Error ? error.message : String(error)))
  }, [])

  async function deleteMessageSpeech(message: Message) {
    if (speechPlayingId === message.id) stopSpeechPlayback()
    await db.speechCache.delete(message.id)
    setToast('已删除语音缓存')
  }

  async function sendFeedback(message: Message, kind: 'unlike' | 'avoid') {
    if (!conversationId) return
    const target = feedbackContactFor(message)
    if (!target) return
    await applyMessageFeedback({ contact: target, message, kind, conversationId })
    setToast(kind === 'unlike' ? '已记住：这不像TA' : '已记住：以后避开这种说法')
  }

  async function regenerateTurn(message: Message, instruction = '') {
    if (!conversationId || !message.debugAiTurnId) return
    if (isGroupConv) {
      if (!group) return
      await regenerateGroupAiTurn(conversationId, group, groupMembers, settings, stickers, message.debugAiTurnId, instruction)
    } else {
      if (!contact) return
      await regenerateAiTurn(conversationId, contact, settings, stickers, message.debugAiTurnId, instruction)
    }
    setToast('已重新生成这一轮')
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

  async function sendSticker(name: string, url: string, provider?: NonNullable<Message['sticker']>['provider']): Promise<boolean> {
    if (!conversationId) return false
    try {
      const createdAt = await nextMessageTimestamp(conversationId)
      await db.transaction('rw', db.messages, db.conversations, async () => {
        await db.messages.add({ id: uuid(), conversationId, role: 'user', type: 'sticker', content: name, sticker: { url, provider }, createdAt })
        await db.conversations.update(conversationId, { updatedAt: createdAt })
      })
      setStickerPickerOpen(false)
      setStickerResults([])
      jumpToLatest()
      if (!isGroupConv && contact) void triggerAiTurn(conversationId, contact, settings, stickers)
      else if (isGroupConv && group) void triggerGroupAiTurn(conversationId, group, groupMembers, settings, stickers)
      return true
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error))
      return false
    }
  }

  async function sendRemoteSticker(result: RemoteStickerResult) {
    const name = result.name?.trim() || stickerQuery.trim() || '远程表情'
    if (await sendSticker(name, result.url, result.provider)) void trackRemoteStickerSend(result)
  }
  const handleFinanceCard = useCallback(async (message: Message) => {
    if(message.type==='redPacket'&&message.role==='assistant'&&message.finance?.transactionId&&message.finance.status==='pending'){try{await claimRedPacket(message.finance.transactionId,USER_WALLET_ID);await db.messages.update(message.id,{finance:{...message.finance,status:'claimed'}});setToast('红包已领取')}catch(e){setToast(e instanceof Error?e.message:String(e))}}
    if(message.type==='loanRequest'&&message.role==='assistant'&&message.finance?.loanId&&message.finance.status==='pending'&&contact){const accept=confirm(`${displayName(contact)}想借 ${message.finance.amount}，是否同意？`);if(accept){try{await transferFunds({from:USER_WALLET_ID,to:contact.id,amount:message.finance.amount,kind:'loan',note:message.finance.note,idempotencyKey:`loan:${message.finance.loanId}`});await db.loans.update(message.finance.loanId,{status:'active',resolvedAt:Date.now()});await db.messages.update(message.id,{finance:{...message.finance,status:'accepted'}})}catch(e){setToast(e instanceof Error?e.message:String(e))}}else{await db.loans.update(message.finance.loanId,{status:'rejected',resolvedAt:Date.now()});await db.messages.update(message.id,{finance:{...message.finance,status:'rejected'}})}}
  }, [contact])
  const handleInternalTaskUndo = useCallback(async (message: Message) => {
    if (message.type !== 'internalTask' || !message.internalTask || message.internalTask.status !== 'active') return
    if (!window.confirm('撤销这次安排？特殊日程将删除，原先被覆盖的安排会恢复。')) return
    try {
      const task = await revertInternalTask(message.internalTask.taskId)
      await db.messages.update(message.id, { internalTask: { ...message.internalTask, status: task.status } })
      setToast('安排已撤销，原日程已恢复')
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error))
    }
  }, [])
  // Stable per-message handlers so the memoized MessageBubble list skips re-rendering while the user types in the composer.
  const registerBubble = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) bubbleRefs.current.set(id, el)
    else bubbleRefs.current.delete(id)
  }, [])
  const handleBubbleLongPress = useCallback((id: string) => setMenuMessageId(id), [])
  const handleBubbleReply = useCallback((id: string) => setReplyToId(id), [])
  const handleLinkClick = useCallback((message: Message) => {
    const routes: Record<string, string> = { work: '/work', shop: '/shop', warehouse: '/warehouse' }
    const path = message.link?.app ? routes[message.link.app] : undefined
    if (path) void navigate(path)
    else setToast('暂不支持这个小程序')
  }, [navigate])
  const handleContactRecommendation = useCallback(async (message: Message, action: 'accept' | 'decline' | 'open') => {
    const recommendation = recommendationFromMessage(message)
    if (!recommendation) { setToast('这张推荐卡的信息不完整'); return }
    if (action === 'open') {
      if (recommendation.contactId) void navigate(`/contact/${recommendation.contactId}`)
      else if (recommendation.taskId) void navigate(`/contact-generation/${recommendation.taskId}`)
      return
    }
    if (action === 'decline') {
      await declineContactRecommendation(message)
      setToast('已婉拒这次推荐')
      return
    }
    if (!contact) return
    try {
      const taskId = await acceptContactRecommendation({ message, recommender: contact, settings, careerEnabled, relationshipEnabled, locationEnabled })
      setToast('已开始生成联系人资料')
      void navigate(`/contact-generation/${taskId}`)
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error))
    }
  }, [careerEnabled, contact, locationEnabled, navigate, relationshipEnabled, settings])
  const handleAvatarClick = useCallback((message: Message) => {
    if (message.role === 'user') {
      void navigate('/profile/edit')
      return
    }
    const targetId = message.speakerContactId ?? contact?.id
    if (targetId) void navigate(`/contact/${targetId}`)
  }, [contact?.id, navigate])
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

  const toggleSelectedMessage = useCallback((id: string) => {
    setSelectedMessageIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]))
  }, [])

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

  if (hiddenTestConversation) return null
  if (conversation === undefined) return null
  if (conversation === null) {
    return (
      <div className="ui-page">
        <TopBar title="对话" showBack />
        <p className="px-4 py-10 text-center text-sm text-gray-400">会话不存在</p>
      </div>
    )
  }
  if (isGroupConv) {
    if (group === undefined) return null
    if (group === null) {
      return (
        <div className="ui-page">
          <TopBar title="群聊" showBack />
          <p className="px-4 py-10 text-center text-sm text-gray-400">该群聊已被解散</p>
        </div>
      )
    }
  } else {
    if (contact === undefined) return null
    if (contact === null) {
      return (
        <div className="ui-page">
          <TopBar title="对话" showBack />
          <p className="px-4 py-10 text-center text-sm text-gray-400">会话不存在</p>
        </div>
      )
    }
  }

  const headerTitle = isGroupConv
    ? group!.kind === 'location' ? `${group!.name} · ${groupLocation?.name ?? '未选择地点'}` : group!.name
    : displayName(contact!)
  const visibleHeaderTitle = aiTyping && typingLabel ? `${typingLabel}正在输入中...` : headerTitle
  const headerInfoPath = isGroupConv ? `/group/${group!.id}` : `/contact/${contact!.id}`
  const chatBackgroundStyle =
    settings.chatBackground && settings.chatBackground.startsWith('data:')
      ? { backgroundImage: `url(${settings.chatBackground})`, backgroundSize: 'cover', backgroundPosition: 'center' }
      : settings.chatBackground
        ? { backgroundColor: settings.chatBackground }
        : undefined

  return (
    <div className="ui-page relative">
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
        <div data-testid="long-press-hint" className="flex shrink-0 items-center gap-2 border-b border-[var(--ui-special-border)] bg-[var(--ui-special-soft)] px-4 py-2 text-[11px] text-[var(--ui-special-ink)]">
          <span className="min-w-0 flex-1">提示：长按 AI 文字消息可以生成单条或整轮语音，也可以重新生成、反馈、复制或删除。</span>
          <button type="button" onClick={dismissLongPressHint} className="shrink-0 rounded px-1.5 py-1 text-[var(--ui-special-ink)]">知道了</button>
        </div>
      )}

      <div
        ref={scrollContainerRef}
        data-testid="chat-scroll"
        className="min-h-0 flex-1 overflow-y-auto pt-2"
        style={chatBackgroundStyle}
        onScroll={(event) => { rememberReadingPosition(); if (event.currentTarget.scrollTop < 80) loadOlderMessages() }}
      >
        <div ref={messageContentRef}>
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
          const speechCache = speechCacheByMessage.get(m.id)
          const speechOwner = m.role === 'assistant' ? (isGroupConv ? speaker : contact ?? undefined) : undefined
          const speechVoice = speechEnabled ? contactSpeechVoice(speechOwner, settings.speechProvider) : undefined
          const speechMatchesCurrentSettings = !!speechVoice && speechCache?.signature === speechSignature(m.content, settings, speechVoice)
          const showConversationTime = !previousMessage || m.createdAt - previousMessage.createdAt > 10 * 60 * 1000
          const msgBubble = (
            <div className="animate-[message-in_180ms_ease-out]">
              {showConversationTime && <p className="my-4 text-center text-[11px] text-gray-400">{new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>}
              <MessageBubble
              registerRef={registerBubble}
              message={m}
              contactName={bubbleName}
              contactAvatar={bubbleAvatar}
              contactAvatarColor={bubbleAvatarColor}
              userAvatar={settings.userAvatar}
              stickerUrl={m.type === 'sticker' ? (m.sticker?.url ?? stickerByName.get(m.content)) : undefined}
              memberById={isGroupConv ? memberById : undefined}
              replyPreview={m.replyToMessageId ? previewForReply(messageById.get(m.replyToMessageId) ?? m) : undefined}
              highlighted={flashId === m.id}
              selecting={selectingMessages}
              selected={selectedMessageIds.includes(m.id)}
              onSelect={toggleSelectedMessage}
              onReply={!selectingMessages && isGroupConv ? handleBubbleReply : undefined}
              onLongPress={handleBubbleLongPress}
              onLinkClick={selectingMessages ? undefined : handleLinkClick}
              onContactRecommendation={selectingMessages ? undefined : handleContactRecommendation}
              onFinanceClick={selectingMessages ? undefined : handleFinanceCard}
              onInternalTaskUndo={selectingMessages ? undefined : handleInternalTaskUndo}
              onAvatarClick={selectingMessages ? undefined : handleAvatarClick}
              speechAvailable={speechEnabled && m.type === 'text' && !!speechCache && speechMatchesCurrentSettings}
              speechLoading={speechEnabled && generatingSpeechIds.has(m.id)}
              speechPlaying={speechEnabled && speechPlayingId === m.id && speechPlaying}
              speechDurationMs={speechEnabled ? speechCache?.durationMs : undefined}
              onSpeechClick={speechEnabled && !selectingMessages ? handleSpeechClick : undefined}
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
                    <div className="rounded-2xl rounded-tl-md border border-[var(--ui-special-border)] bg-[var(--ui-special-soft)] px-3.5 py-2">
                      <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-[var(--ui-special-ink)]">
                        <UiIcon name="🔮" size={13} className="mt-0.5 shrink-0" />
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
      </div>

      {awayFromLatest && <div className="shrink-0 bg-white px-3 py-1 text-right"><button type="button" onClick={jumpToLatest} className="min-h-10 rounded-lg bg-gray-100 px-3 text-xs text-gray-700">回到最新消息</button></div>}
      {error && (
        <div className="flex items-center gap-3 bg-red-50 px-4 py-1.5 text-xs text-red-500">
          <p className="min-w-0 flex-1">{error}</p>
          <button
            type="button"
            onClick={!settings.apiKey ? () => navigate('/settings/api-configurations') : error.startsWith('消息未发送，输入已保留') ? () => useChatEngineStore.getState().patch(conversationId!, { error: '' }) : retryCurrentTurn}
            disabled={aiTyping}
            className="shrink-0 rounded-md border border-red-200 bg-white px-2.5 py-1 font-medium text-red-600 disabled:opacity-50"
          >
            {!settings.apiKey ? '去配置' : error.startsWith('消息未发送，输入已保留') ? '继续编辑' : '再次尝试'}
          </button>
        </div>
      )}
      {toast && (
        <p className="bg-gray-100 px-4 py-1.5 text-center text-xs text-gray-500" onAnimationEnd={() => setToast('')}>
          {toast}
        </p>
      )}

      <div className={desktop ? 'desktop-chat-composer-shell shrink-0 bg-white' : 'shrink-0 border-t border-gray-200 bg-white p-2 pb-[env(safe-area-inset-bottom)]'}>
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
                <button onClick={() => setReplyToId(null)} className="min-h-10 min-w-10 shrink-0 text-gray-400">
                  取消
                </button>
              </div>
            )}
            {latestRegeneratableMessage && <div className="mb-2 flex items-center gap-2">
              <button type="button" disabled={aiTyping} onClick={() => void regenerateTurn(latestRegeneratableMessage).catch((error: unknown) => setToast(error instanceof Error ? error.message : String(error)))} className="min-h-10 rounded-lg bg-gray-100 px-3 text-xs text-gray-700 disabled:opacity-40">重新生成</button>
              <button type="button" disabled={aiTyping} onClick={() => { setRegenerationInstruction(''); setRegenerationMessageId(latestRegeneratableMessage.id) }} className="min-h-10 rounded-lg bg-gray-100 px-3 text-xs text-gray-700 disabled:opacity-40">附加要求</button>
            </div>}
            <ChatComposer
              key={conversationId}
              desktop={desktop}
              aiTyping={aiTyping}
              members={isGroupConv ? groupMembers : EMPTY_CONTACTS}
              onSend={handleSend}
              onStop={handleStopGeneration}
              tools={desktop ? <>
                <button type="button" onClick={openStickers} aria-label="搜索表情包" title="表情包"><StickerIcon size={18} /></button>
                {!isGroupConv && careerEnabled && <>
                  <span className="desktop-chat-tool-divider" />
                  <button type="button" onClick={() => setFinanceMode('transfer')} aria-label="转账" title="转账"><ArrowLeftRight size={18} /></button>
                  <button type="button" onClick={() => setFinanceMode('redPacket')} aria-label="红包" title="红包"><Gift size={18} /></button>
                  <button type="button" onClick={() => setFinanceMode('loan')} aria-label="借款" title="借款"><HandCoins size={18} /></button>
                  <button type="button" onClick={() => void repayLoan()} aria-label="归还借款" title="归还借款"><CircleDollarSign size={18} /></button>
                </>}
                {careerEnabled && <button type="button" onClick={() => navigate('/work')} aria-label="工作" title="工作"><BriefcaseBusiness size={18} /></button>}
                {shopEnabled && <button type="button" onClick={() => navigate('/shop')} aria-label="商城" title="商城"><ShoppingBag size={18} /></button>}
                {warehouseEnabled && <button type="button" onClick={() => navigate('/warehouse')} aria-label="仓库" title="仓库"><Package size={18} /></button>}
              </> : <>
                <button type="button" onClick={() => setAppsOpen(true)} aria-label="更多聊天功能" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-600"><Plus size={20} /></button>
                <button type="button" onClick={openStickers} aria-label="搜索表情包" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-600"><StickerIcon size={20} /></button>
              </>}
            />
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
          title="消息操作"
          onClose={() => setMenuMessageId(null)}
          options={[
            { group: '常用操作', label: '复制', onSelect: () => void copyMessage(menuMessage) },
            ...(isGroupConv && menuMessage.image?.presentation !== 'illustration' ? [{ group: '常用操作', label: '回复', onSelect: () => setReplyToId(menuMessage.id) }] : []),
            { group: '常用操作', label: '选择转发截图', onSelect: () => beginMessageSelection(menuMessage.id) },
            ...(speechEnabled && menuMessage.type === 'text' && menuMessage.role === 'assistant'
              ? !!menuSpeechVoice && speechCacheByMessage.get(menuMessage.id)?.signature === speechSignature(menuMessage.content, settings, menuSpeechVoice)
                ? [
                    { group: '语音', label: speechPlayingId === menuMessage.id && speechPlaying ? '暂停语音' : '播放语音', onSelect: () => handleSpeechClick(menuMessage) },
                    { group: '语音', label: '重新生成语音', onSelect: () => void generateMessageSpeech(menuMessage, true) },
                    { group: '语音', label: '删除语音缓存', onSelect: () => void deleteMessageSpeech(menuMessage) },
                  ]
                : [{ group: '语音', label: '生成语音', onSelect: () => void generateMessageSpeech(menuMessage) }]
              : []),
            ...(speechEnabled && menuMessage.role === 'assistant' && menuMessage.type === 'text'
              ? [{ group: '语音', label: '生成这一轮全部语音', onSelect: () => void generateReplyRoundSpeech(menuMessage) }]
              : []),
            ...(feedbackContactFor(menuMessage)
              ? [
                  ...(menuMessage.debugAiTurnId
                    ? [{ group: '重新生成与反馈', label: '重新生成这一轮', onSelect: () => { setRegenerationInstruction(''); setRegenerationMessageId(menuMessage.id) } }]
                    : []),
                  { group: '重新生成与反馈', label: '这不像TA', onSelect: () => void sendFeedback(menuMessage, 'unlike') },
                  { group: '重新生成与反馈', label: '以后别这样说', onSelect: () => void sendFeedback(menuMessage, 'avoid') },
                ]
              : []),
            { group: '删除', label: '删除这条消息', onSelect: () => void deleteMessage(menuMessage), danger: true },
          ]}
        />
      )}
      {regenerationMessage && (
        <div className="absolute inset-0 z-50 flex items-end bg-black/30" onClick={() => setRegenerationMessageId(null)}>
          <div className="w-full rounded-t-2xl bg-white p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]" onClick={(event) => event.stopPropagation()}>
            <h2 className="text-base font-semibold text-gray-900">重新生成这一轮</h2>
            <p className="mt-1 text-xs leading-5 text-gray-500">可选：告诉 AI 这件事应当如何发展。本次生成会严格遵循该指令，但不会把它发送到聊天记录中。</p>
            <textarea
              autoFocus
              value={regenerationInstruction}
              onChange={(event) => setRegenerationInstruction(event.target.value)}
              placeholder="例如：这时候应该先解释原因并道歉，不要突然冷淡。"
              rows={4}
              className="mt-3 w-full resize-none rounded-xl border border-gray-200 px-3 py-2.5 text-sm text-gray-900 outline-none placeholder:text-gray-400 focus:border-gray-500"
            />
            <div className="mt-3 flex gap-2">
              <button type="button" onClick={() => setRegenerationMessageId(null)} className="flex-1 rounded-xl bg-gray-100 py-2.5 text-sm text-gray-700">取消</button>
              <button
                type="button"
                onClick={() => {
                  const instruction = regenerationInstruction.trim()
                  setRegenerationMessageId(null)
                  void regenerateTurn(regenerationMessage, instruction)
                }}
                className="flex-1 rounded-xl bg-gray-900 py-2.5 text-sm text-white"
              >
                重新生成
              </button>
            </div>
          </div>
        </div>
      )}
      {stickerPickerOpen && (
        <div className="absolute inset-0 z-50 flex items-end bg-black/30" onClick={() => setStickerPickerOpen(false)}>
          <div className="flex max-h-[78%] w-full flex-col rounded-t-2xl bg-white pb-[env(safe-area-inset-bottom)]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 border-b border-gray-100 p-3">
              <input value={stickerQuery} onChange={(e) => setStickerQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void searchStickers() }} placeholder="搜一个表情包，例如：猫猫、无语" className="min-w-0 flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm" />
              <button type="button" onClick={() => void searchStickers()} disabled={stickerBusy} className="rounded-lg bg-gray-900 px-3 py-2 text-sm text-white disabled:opacity-40">{stickerBusy ? '搜索中' : '搜索'}</button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {stickers.length > 0 && <><h3 className="mb-2 text-xs text-gray-500">我的表情</h3><div className="mb-4 grid grid-cols-4 gap-2">{stickers.map((sticker) => <button key={sticker.id} type="button" onClick={() => void sendSticker(sticker.name, sticker.dataUrl)} className="aspect-square overflow-hidden rounded-xl bg-gray-100"><img src={sticker.dataUrl} alt={sticker.name} className="h-full w-full object-contain" /></button>)}</div></>}
              {stickerResults.length === 0 ? <p className="py-8 text-center text-xs text-gray-400">输入关键词后搜索，点图片即可发送</p> : <div className="grid grid-cols-3 gap-2">{stickerResults.map((result, index) => <button key={`${result.url}-${index}`} type="button" onClick={() => void sendRemoteSticker(result)} className="aspect-square overflow-hidden rounded-xl bg-gray-100"><img src={result.url} alt={result.name || stickerQuery} loading="lazy" className="h-full w-full object-cover" /></button>)}</div>}
              {settings.stickerProvider !== 'none' && <p className="mt-3 text-center text-[10px] text-gray-400">Powered by {stickerProviderName(settings.stickerProvider)}</p>}
            </div>
          </div>
        </div>
      )}
      {appsOpen && (
        <ActionSheet onClose={()=>setAppsOpen(false)} options={[
          {label:'搜索远程表情包',onSelect:()=>{setAppsOpen(false);setStickerPickerOpen(true);setStickerQuery('');setStickerResults([])}},
          ...(!isGroupConv&&careerEnabled?[{label:'转账',onSelect:()=>{setAppsOpen(false);setFinanceMode('transfer' as const)}},{label:'红包',onSelect:()=>{setAppsOpen(false);setFinanceMode('redPacket' as const)}},{label:'借款',onSelect:()=>{setAppsOpen(false);setFinanceMode('loan' as const)}},{label:'归还借款',onSelect:()=>{setAppsOpen(false);void repayLoan()}}]:[]),
          ...(careerEnabled?[{label:'工作',onSelect:()=>navigate('/work')}]:[]),
          ...(shopEnabled?[{label:'商城',onSelect:()=>navigate('/shop')}]:[]),
          ...(warehouseEnabled?[{label:'仓库',onSelect:()=>navigate('/warehouse')}]:[])
        ]}/>
      )}
      {financeMode&&<div className="absolute inset-0 z-50 flex items-end bg-black/30" onClick={()=>setFinanceMode(null)}><div className="w-full rounded-t-2xl bg-white p-4" onClick={e=>e.stopPropagation()}><h3 className="font-medium">{financeMode==='transfer'?'转账':financeMode==='redPacket'?'发红包':'向TA借款'}</h3><input type="number" min="1" value={financeAmount} onChange={e=>setFinanceAmount(e.target.value)} placeholder="金额" className="mt-3 w-full rounded-lg border px-3 py-2"/><input value={financeNote} onChange={e=>setFinanceNote(e.target.value)} placeholder="备注或借款理由" className="mt-2 w-full rounded-lg border px-3 py-2"/><button onClick={submitFinance} className="mt-3 w-full rounded-lg bg-gray-900 py-2.5 text-white">确认</button></div></div>}
    </div>
  )
}
