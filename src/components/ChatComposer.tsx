import { useRef, useState, type ReactNode } from 'react'
import type { Contact } from '../types'
import { displayName } from '../lib/contact'

interface ChatComposerProps {
  desktop: boolean
  aiTyping: boolean
  members: Contact[]
  tools: ReactNode
  onSend: (text: string, mentions: string[]) => Promise<boolean>
  onStop: () => void
}

/** Draft and keystrokes stay here so typing does not redraw the message list. */
export function ChatComposer({ desktop, aiTyping, members, tools, onSend, onStop }: ChatComposerProps) {
  const [input, setInput] = useState('')
  const [mentionIds, setMentionIds] = useState<string[]>([])
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)
  const draftRevision = useRef(0)
  const query = input.match(/(?:^|\s)@([^\s@]*)$/)?.[1].toLowerCase()
  const candidates = query === undefined ? [] : members.filter((member) => displayName(member).toLowerCase().includes(query)).slice(0, 6)

  async function send() {
    const text = input.trim()
    if (!text || sendingRef.current) return
    sendingRef.current = true
    setSending(true)
    const revision = draftRevision.current
    const mentions = Array.from(new Set([...mentionIds, ...members.filter((member) => text.includes(`@${displayName(member)}`)).map((member) => member.id)]))
    try {
      if (await onSend(text, mentions) && revision === draftRevision.current) {
        setInput('')
        setMentionIds([])
      }
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  const showStop = aiTyping && !input.trim()
  const sendButton = (
    <button type="button" onClick={showStop ? onStop : () => void send()} disabled={sending || (!showStop && !input.trim())}
      aria-label={showStop ? '停止生成' : '发送消息'}
      className={desktop ? 'desktop-chat-send' : 'min-h-10 w-16 shrink-0 rounded-xl bg-gray-900 px-2 py-2 text-sm text-white disabled:opacity-40'}>
      {sending ? '发送中' : showStop ? '停止' : '发送'}
    </button>
  )
  const textarea = (
    <textarea value={input} onChange={(event) => { draftRevision.current++; setInput(event.target.value) }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
          event.preventDefault()
          void send()
        }
      }}
      placeholder={aiTyping ? '对方正在输入，你可以直接插话打断' : desktop ? '输入消息…' : '发消息…'}
      rows={desktop ? 4 : 1}
      className={desktop ? 'desktop-chat-textarea' : 'max-h-24 min-w-0 flex-1 resize-none rounded-xl border border-gray-200 px-3 py-2 text-[14.5px] outline-none'} />
  )

  return (
    <>
      {candidates.length > 0 && <div className="mb-2 max-h-44 overflow-y-auto rounded-xl border border-gray-100 bg-white shadow-sm">
        {candidates.map((member) => <button type="button" key={member.id} onClick={() => {
          draftRevision.current++
          setInput((value) => value.replace(/(?:^|\s)@([^\s@]*)$/, (match) => `${match.startsWith(' ') ? ' ' : ''}@${displayName(member)} `))
          setMentionIds((ids) => Array.from(new Set([...ids, member.id])))
        }} className="flex min-h-10 w-full items-center px-3 py-2 text-left text-sm text-gray-800">@{displayName(member)}</button>)}
      </div>}
      {desktop ? <div className="desktop-chat-composer">{textarea}<div className="desktop-chat-tools"><div className="desktop-chat-tool-group">{tools}</div>{sendButton}</div></div>
        : <div className="flex items-end gap-2">{tools}{textarea}{sendButton}</div>}
    </>
  )
}
