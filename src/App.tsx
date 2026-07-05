import { useEffect } from 'react'
import { Route, Routes } from 'react-router-dom'
import { useSettingsStore } from './store/useSettingsStore'
import { refreshMoments } from './lib/moments'
import { AUTONOMOUS_TICK_INTERVAL_MS, maybeTriggerProactiveMessage } from './lib/proactiveChat'
import { installConsoleCapture } from './lib/consoleCapture'
import { TabLayout } from './components/TabLayout'
import { MessagesPage } from './pages/MessagesPage'
import { ContactsPage } from './pages/ContactsPage'
import { DiscoverPage } from './pages/DiscoverPage'
import { MePage } from './pages/MePage'
import { ChatPage } from './pages/ChatPage'
import { ContactCardPage } from './pages/ContactCardPage'
import { ContactAddPage } from './pages/ContactAddPage'
import { GroupAddPage } from './pages/GroupAddPage'
import { GroupInfoPage } from './pages/GroupInfoPage'
import { TodoPage } from './pages/TodoPage'
import { RelationshipsPage } from './pages/RelationshipsPage'
import { ShopPage } from './pages/ShopPage'
import { WarehousePage } from './pages/WarehousePage'
import { MomentsPage } from './pages/MomentsPage'
import { SettingsPage } from './pages/SettingsPage'
import { StickersPage } from './pages/StickersPage'
import { ProfileEditPage } from './pages/ProfileEditPage'
import { WorldSettingsPage } from './pages/WorldSettingsPage'
import { SkyEyePage } from './pages/SkyEyePage'
import { NotificationBanner } from './components/NotificationBanner'

// Runs once at module load, regardless of admin mode — so there's already
// log history by the time someone opens "天眼".
installConsoleCapture()

/**
 * "Looks autonomous while the app is open" — a foreground timer that
 * periodically lets AIs post moments / proactively open a chat, gated
 * behind the settings toggle (off by default, since it makes real API
 * calls with no direct user action). There's no backend, so none of this
 * runs once the tab is closed — see the design discussion in CLAUDE.md.
 */
function useAutonomousBehaviorTimer() {
  const enabled = useSettingsStore((s) => s.autonomousBehaviorEnabled)

  useEffect(() => {
    if (!enabled) return
    const tick = () => {
      const settings = useSettingsStore.getState()
      refreshMoments(settings).catch(() => {})
      maybeTriggerProactiveMessage(settings).catch(() => {})
    }
    const id = setInterval(tick, AUTONOMOUS_TICK_INTERVAL_MS)
    return () => clearInterval(id)
  }, [enabled])
}

function App() {
  useAutonomousBehaviorTimer()

  return (
    <div className="app-shell">
      <NotificationBanner />
      <Routes>
        <Route element={<TabLayout />}>
          <Route path="/" element={<MessagesPage />} />
          <Route path="/contacts" element={<ContactsPage />} />
          <Route path="/todos" element={<TodoPage />} />
          <Route path="/discover" element={<DiscoverPage />} />
          <Route path="/me" element={<MePage />} />
        </Route>
        <Route path="/chat/:conversationId" element={<ChatPage />} />
        <Route path="/contact/new" element={<ContactAddPage />} />
        <Route path="/contact/:contactId" element={<ContactCardPage />} />
        <Route path="/group/new" element={<GroupAddPage />} />
        <Route path="/group/:groupId" element={<GroupInfoPage />} />
        <Route path="/relationships" element={<RelationshipsPage />} />
        <Route path="/shop" element={<ShopPage />} />
        <Route path="/warehouse" element={<WarehousePage />} />
        <Route path="/moments" element={<MomentsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/stickers" element={<StickersPage />} />
        <Route path="/profile/edit" element={<ProfileEditPage />} />
        <Route path="/world-settings" element={<WorldSettingsPage />} />
        <Route path="/sky-eye" element={<SkyEyePage />} />
      </Routes>
    </div>
  )
}

export default App
