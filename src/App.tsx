import { useEffect, useMemo } from 'react'
import { Route, Routes } from 'react-router-dom'
import { App as CapacitorApp } from '@capacitor/app'
import { useSettingsStore } from './store/useSettingsStore'
import { refreshMoments } from './lib/moments'
import { maybeTriggerProactiveMessage } from './lib/proactiveChat'
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
import { MomentsPage } from './pages/MomentsPage'
import { SettingsPage } from './pages/SettingsPage'
import { StickersPage } from './pages/StickersPage'
import { ProfileEditPage } from './pages/ProfileEditPage'
import { ModulesPage } from './pages/ModulesPage'
import { SkyEyePage } from './pages/SkyEyePage'
import { ALL_MODULES, useModuleEnabled } from './features'
import { NotificationBanner } from './components/NotificationBanner'
import { ensureWallets, settleSalaries } from './lib/finance'
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
  const enabled = useModuleEnabled('proactiveChat')

  useEffect(() => {
    if (!enabled) return
    const tick = () => {
      const settings = useSettingsStore.getState()
      refreshMoments(settings).catch(() => {})
      maybeTriggerProactiveMessage(settings).catch(() => {})
    }
    const id = setInterval(tick, useSettingsStore.getState().proactiveTickIntervalMs)
    return () => clearInterval(id)
  }, [enabled])
}

/**
 * Without this, Android's hardware/gesture back button just closes the
 * whole app from any screen — Capacitor's default is to let the native
 * WebView's own back-navigation stack drive it, but this app is a
 * HashRouter SPA where "navigate back" means moving through the hash
 * history, not the WebView's page-load history. `canGoBack` is Capacitor's
 * own answer to "is there anywhere to go back to" (tracked natively from
 * the WebView's history), so this defers to it rather than guessing from
 * the current route. No-ops harmlessly on web (the browser's own back
 * button/gesture already works there; this listener just never fires).
 */
function useAndroidBackButton() {
  useEffect(() => {
    const listenerPromise = CapacitorApp.addListener('backButton', ({ canGoBack }) => {
      if (canGoBack) {
        window.history.back()
      } else {
        CapacitorApp.exitApp()
      }
    })
    return () => {
      listenerPromise.then((l) => l.remove())
    }
  }, [])
}

function App() {
  useAutonomousBehaviorTimer()
  useAndroidBackButton()
  const themeMode = useSettingsStore((s) => s.themeMode ?? 'light')
  const adminModeEnabled = useSettingsStore((s) => s.adminModeEnabled)
  const enabledModules = useSettingsStore((s) => s.enabledModules)
  useEffect(() => { void ensureWallets().then(() => settleSalaries()) }, [enabledModules])

  // Build deduplicated route list from enabled modules.
  const moduleRoutes = useMemo(() => {
    const seen = new Set<string>()
    const routes: { path: string; Component: React.ComponentType }[] = []
    for (const m of ALL_MODULES) {
      if (!enabledModules.includes(m.id)) continue
      for (const r of m.routes ?? []) {
        if (seen.has(r.path)) continue
        seen.add(r.path)
        routes.push({ path: r.path, Component: r.component })
      }
    }
    return routes
  }, [enabledModules])

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode
  }, [themeMode])

  return (
    <div className={`app-shell ${themeMode === 'dark' ? 'theme-dark' : ''}`}>
      <NotificationBanner />
      <Routes>
        <Route element={<TabLayout />}>
          <Route path="/" element={<MessagesPage />} />
          <Route path="/contacts" element={<ContactsPage />} />
          <Route path="/discover" element={<DiscoverPage />} />
          <Route path="/me" element={<MePage />} />
        </Route>
        <Route path="/chat/:conversationId" element={<ChatPage />} />
        <Route path="/contact/new" element={<ContactAddPage />} />
        <Route path="/contact/:contactId" element={<ContactCardPage />} />
        <Route path="/group/new" element={<GroupAddPage />} />
        <Route path="/group/:groupId" element={<GroupInfoPage />} />
        <Route path="/moments" element={<MomentsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/stickers" element={<StickersPage />} />
        <Route path="/profile/edit" element={<ProfileEditPage />} />
        <Route path="/modules" element={<ModulesPage />} />
        {moduleRoutes.map((r) => (
          <Route key={r.path} path={r.path} element={<r.Component />} />
        ))}
        {adminModeEnabled && (
          <Route path="/sky-eye" element={<SkyEyePage />} />
        )}
      </Routes>
    </div>
  )
}

export default App
