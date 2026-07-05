import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useChatUiStore } from '../store/useChatUiStore'
import { Avatar } from './Avatar'

const AUTO_DISMISS_MS = 4000

export function NotificationBanner() {
  const navigate = useNavigate()
  const notification = useChatUiStore((s) => s.notification)
  const dismissNotification = useChatUiStore((s) => s.dismissNotification)

  useEffect(() => {
    if (!notification) return
    const t = setTimeout(() => dismissNotification(), AUTO_DISMISS_MS)
    return () => clearTimeout(t)
  }, [notification, dismissNotification])

  if (!notification) return null

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => {
        navigate(`/chat/${notification.conversationId}`)
        dismissNotification()
      }}
      className="absolute left-2 right-2 top-2 z-50 flex items-center gap-2.5 rounded-2xl bg-white p-3 text-left shadow-lg ring-1 ring-black/5"
      style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.75rem)' }}
    >
      <Avatar avatar={notification.contactAvatar} color={notification.contactAvatarColor} size={36} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-gray-900">{notification.contactName}</p>
        <p className="truncate text-[12.5px] text-gray-500">{notification.preview}</p>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation()
          dismissNotification()
        }}
        className="shrink-0 px-1 text-gray-300"
        aria-label="关闭通知"
      >
        ✕
      </button>
    </div>
  )
}
