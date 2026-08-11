import { lazy, Suspense, useEffect, useMemo, useState, type ElementType } from 'react'
import { Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { App as CapacitorApp } from '@capacitor/app'
import { useSettingsStore } from './store/useSettingsStore'
import { refreshMoments } from './lib/moments'
import { maybeTriggerProactiveMessage } from './lib/proactiveChat'
import { installConsoleCapture } from './lib/consoleCapture'
import { TabLayout } from './components/TabLayout'
import { ALL_MODULES, isModuleAllowedInExperienceMode, useModuleEnabled } from './features'
import { NotificationBanner } from './components/NotificationBanner'
import { AppErrorBoundary } from './components/AppErrorBoundary'
import { DesktopLayout } from './components/DesktopLayout'
import { DesktopHomePage } from './pages/DesktopHomePage'
import { DesktopContactsPage } from './pages/DesktopContactsPage'
import { ensureWallets } from './lib/finance'
import { ensureLegacyWorldviewMigrated } from './lib/worldbook'
import { ensureWorldSnapshotsMigrated } from './lib/worldSnapshots'
import { managedBackParent, replaceHashRoute } from './lib/navigationHierarchy'
import { syncContactLocationsAt } from './lib/locations'
import { initializeContactGenerationTasks } from './lib/contactGenerationTasks'
import { ensureContactPromptSnapshots } from './lib/promptPresets'
import { resumeMediaAssets } from './lib/imageAssets'
// Tab pages are the landing screen — keep them eager. Everything else is
// route-level code-split (lazy) so the initial bundle stays small; matches
// how features/* already lazy-load their pages.
import { MessagesPage } from './pages/MessagesPage'
import { ContactsPage } from './pages/ContactsPage'
import { DiscoverPage } from './pages/DiscoverPage'
import { MePage } from './pages/MePage'
const loadChatPage = () => import('./pages/ChatPage')
const loadContactCardPage = () => import('./pages/ContactCardPage')
const loadContactAddPage = () => import('./pages/ContactAddPage')
const loadMomentsPage = () => import('./pages/MomentsPage')
const loadSettingsPage = () => import('./pages/SettingsPage')
const loadImageProviderListPage = () => import('./pages/ImageProviderListPage')
const loadImageProviderSettingsPage = () => import('./pages/ImageProviderSettingsPage')
const loadOtherInterfacesPage = () => import('./pages/OtherInterfacesPage')
const ChatPage = lazy(() => loadChatPage().then((m) => ({ default: m.ChatPage })))
const ContactCardPage = lazy(() => loadContactCardPage().then((m) => ({ default: m.ContactCardPage })))
const ContactAdminPage = lazy(() => import('./pages/ContactAdminPage').then((m) => ({ default: m.ContactAdminPage })))
const ContactAddPage = lazy(() => loadContactAddPage().then((m) => ({ default: m.ContactAddPage })))
const ContactGenerationTaskPage = lazy(() => import('./pages/ContactGenerationTaskPage').then((m) => ({ default: m.ContactGenerationTaskPage })))
const GroupAddPage = lazy(() => import('./pages/GroupAddPage').then((m) => ({ default: m.GroupAddPage })))
const GroupInfoPage = lazy(() => import('./pages/GroupInfoPage').then((m) => ({ default: m.GroupInfoPage })))
const MomentsPage = lazy(() => loadMomentsPage().then((m) => ({ default: m.MomentsPage })))
const SettingsPage = lazy(() => loadSettingsPage().then((m) => ({ default: m.SettingsPage })))
const GlobalPromptModulesPage = lazy(() => import('./pages/GlobalPromptModulesPage').then((m) => ({ default: m.GlobalPromptModulesPage })))
const AppearancePage = lazy(() => import('./pages/AppearancePage').then((m) => ({ default: m.AppearancePage })))
const ExperienceModePage = lazy(() => import('./pages/ExperienceModePage').then((m) => ({ default: m.ExperienceModePage })))
const StickersPage = lazy(() => import('./pages/StickersPage').then((m) => ({ default: m.StickersPage })))
const StickerProviderListPage = lazy(() => import('./pages/StickerProviderListPage').then((m) => ({ default: m.StickerProviderListPage })))
const StickerProviderSettingsPage = lazy(() => import('./pages/StickerProviderSettingsPage').then((m) => ({ default: m.StickerProviderSettingsPage })))
const ImageProviderListPage = lazy(() => loadImageProviderListPage().then((m) => ({ default: m.ImageProviderListPage })))
const ImageProviderSettingsPage = lazy(() => loadImageProviderSettingsPage().then((m) => ({ default: m.ImageProviderSettingsPage })))
const OtherInterfacesPage = lazy(() => loadOtherInterfacesPage().then((m) => ({ default: m.OtherInterfacesPage })))
const SpeechProviderListPage = lazy(() => import('./pages/SpeechProviderListPage').then((m) => ({ default: m.SpeechProviderListPage })))
const SpeechProviderSettingsPage = lazy(() => import('./pages/SpeechProviderSettingsPage').then((m) => ({ default: m.SpeechProviderSettingsPage })))
const AiTestCardsPage = lazy(() => import('./pages/AiTestCardsPage').then((m) => ({ default: m.AiTestCardsPage })))
const ProfileEditPage = lazy(() => import('./pages/ProfileEditPage').then((m) => ({ default: m.ProfileEditPage })))
const ModulesPage = lazy(() => import('./pages/ModulesPage').then((m) => ({ default: m.ModulesPage })))
const SkyEyePage = lazy(() => import('./pages/SkyEyePage').then((m) => ({ default: m.SkyEyePage })))
const SocialInboxPage = lazy(() => import('./pages/SocialInboxPage').then((m) => ({ default: m.SocialInboxPage })))
import { WebPrivacyNotice } from './components/WebPrivacyNotice'
// Runs once at module load, regardless of admin mode — so there's already
// log history by the time someone opens "天眼".
installConsoleCapture()

function RouteLoadingFallback({ desktop }: { desktop: boolean }) {
  if (desktop) {
    return (
      <div className="desktop-route-loading" role="status" aria-label="页面加载中">
        <span className="desktop-route-loading-spinner" />
        <span>正在打开…</span>
      </div>
    )
  }
  return <div className="flex h-full items-center justify-center bg-[#f4f4f6] text-sm text-gray-400">加载中…</div>
}


/**
 * "Looks autonomous while the app is open" — a foreground timer that
 * periodically lets AIs post moments / proactively open a chat, gated
 * behind the settings toggle (off by default, since it makes real API
 * calls with no direct user action). There's no backend, so none of this
 * runs once the tab is closed — see the design discussion in CLAUDE.md.
 */
function useAutonomousBehaviorTimer() {
  const enabled = useModuleEnabled('proactiveChat')
  const intervalMs = useSettingsStore((s) => s.proactiveTickIntervalMs)

  useEffect(() => {
    if (!enabled) return
    const tick = () => {
      const settings = useSettingsStore.getState()
      refreshMoments(settings).catch(() => {})
      maybeTriggerProactiveMessage(settings).catch(() => {})
    }
    const id = setInterval(tick, intervalMs)
    return () => clearInterval(id)
  }, [enabled, intervalMs])
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
      const pathname = window.location.hash.slice(1).split('?')[0] || '/'
      const managedParent = managedBackParent(pathname)
      if (managedParent) {
        replaceHashRoute(managedParent)
        return
      }
      if (canGoBack) {
        window.history.back()
      } else {
        void CapacitorApp.exitApp()
      }
    })
    return () => {
      void listenerPromise.then((l) => l.remove())
    }
  }, [])
}

function useLocationResumeSync() {
  const enabled = useModuleEnabled('location')
  useEffect(() => {
    if (!enabled) return
    const syncWhenVisible = () => {
      if (document.visibilityState === 'visible') void syncContactLocationsAt(new Date())
    }
    syncWhenVisible()
    const timer = window.setInterval(syncWhenVisible, 60_000)
    document.addEventListener('visibilitychange', syncWhenVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', syncWhenVisible)
    }
  }, [enabled])
}

function App() {
  useAutonomousBehaviorTimer()
  const [worldReady, setWorldReady] = useState(false)
  const [worldError, setWorldError] = useState('')
  useEffect(() => { if (worldReady) void resumeMediaAssets() }, [worldReady])
  useAndroidBackButton()
  useLocationResumeSync()
  const themeMode = useSettingsStore((s) => s.themeMode ?? 'light')
  const uiTheme = useSettingsStore((s) => s.uiTheme ?? 'sage')
  const animationsEnabled = useSettingsStore((s) => s.animationsEnabled ?? true)
  const adminModeEnabled = useSettingsStore((s) => s.adminModeEnabled)
  const enabledModules = useSettingsStore((s) => s.enabledModules)
  const experienceMode = useSettingsStore((s) => s.experienceMode)
  const location = useLocation()
  const desktop = Boolean(window.talkDesktop)
  useEffect(() => { if (worldReady) void ensureWallets() }, [enabledModules, worldReady])
  useEffect(() => {
    let cancelled = false
    void ensureLegacyWorldviewMigrated()
      .then(() => ensureWorldSnapshotsMigrated())
      .then(() => { if (!cancelled) setWorldReady(true) })
      .catch((error: unknown) => { if (!cancelled) setWorldError(error instanceof Error ? error.message : String(error)) })
    return () => { cancelled = true }
  }, [])
  useEffect(() => { if (worldReady) void initializeContactGenerationTasks() }, [worldReady])
  useEffect(() => { if (worldReady) void ensureContactPromptSnapshots(useSettingsStore.getState()) }, [worldReady])
  useEffect(() => {
    if (!desktop) return
    // Warm the routes people open most often after the desktop shell settles.
    // Dynamic imports are cached, so lazy() reuses these exact promises later.
    const timer = window.setTimeout(() => {
      void Promise.allSettled([
        loadChatPage(),
        loadContactCardPage(),
        loadContactAddPage(),
        loadMomentsPage(),
        loadSettingsPage(),
        loadImageProviderListPage(),
        loadImageProviderSettingsPage(),
      ])
    }, 300)
    return () => window.clearTimeout(timer)
  }, [desktop])

  // Build deduplicated route list from enabled modules.
  const moduleRoutes = useMemo(() => {
    const seen = new Set<string>()
    const routes: { path: string; Component: ElementType }[] = []
    for (const m of ALL_MODULES) {
      if (!enabledModules.includes(m.id) || !isModuleAllowedInExperienceMode(m.id, experienceMode)) continue
      for (const r of m.routes ?? []) {
        if (seen.has(r.path)) continue
        seen.add(r.path)
        routes.push({ path: r.path, Component: r.component })
      }
    }
    return routes
  }, [enabledModules, experienceMode])

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode
  }, [themeMode])
  useEffect(() => {
    document.documentElement.dataset.uiTheme = uiTheme
  }, [uiTheme])
  useEffect(() => {
    document.documentElement.dataset.animations = animationsEnabled ? 'on' : 'off'
  }, [animationsEnabled])
  useEffect(() => {
    if (!animationsEnabled) return
    const surface = document.querySelector<HTMLElement>(desktop ? '.desktop-main' : '.app-shell')
    if (!surface) return
    const animationClass = desktop ? 'desktop-page-transition' : 'page-transition'
    surface.classList.remove(animationClass)
    void surface.offsetWidth
    surface.classList.add(animationClass)
  }, [location.pathname, animationsEnabled, desktop])

  const routeContent = !worldReady ? (
    <div className="flex h-full items-center justify-center bg-[#f4f4f6] px-6 text-center text-sm text-gray-400">{worldError ? `世界数据初始化失败：${worldError}` : '正在载入世界数据…'}</div>
  ) : (
    <Suspense fallback={<RouteLoadingFallback desktop={desktop} />}>
        <Routes>
        <Route element={desktop ? <Outlet /> : <TabLayout />}>
          <Route path="/" element={desktop ? <DesktopHomePage /> : <MessagesPage />} />
          <Route path="/contacts" element={desktop ? <DesktopContactsPage /> : <ContactsPage />} />
          <Route path="/discover" element={<DiscoverPage />} />
          <Route path="/me" element={<MePage />} />
        </Route>
        <Route path="/chat/:conversationId" element={<ChatPage />} />
        <Route path="/contact/new" element={<ContactAddPage />} />
        <Route path="/contact-generation/:taskId" element={<ContactGenerationTaskPage />} />
        <Route path="/contact/:contactId" element={<ContactCardPage />} />
        <Route path="/group/new" element={<GroupAddPage />} />
        <Route path="/group/:groupId" element={<GroupInfoPage />} />
        <Route path="/moments" element={<MomentsPage />} />
        <Route path="/social-inbox" element={<SocialInboxPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/settings/other-interfaces" element={<OtherInterfacesPage />} />
        <Route path="/presets" element={<GlobalPromptModulesPage />} />
        <Route path="/settings/global-prompts" element={<GlobalPromptModulesPage />} />
        <Route path="/appearance" element={<AppearancePage />} />
        <Route path="/experience-mode" element={<ExperienceModePage />} />
        <Route path="/settings/image-generation" element={<ImageProviderListPage />} />
        <Route path="/settings/image-generation/:providerId" element={<ImageProviderSettingsPage />} />
        <Route path="/settings/speech-generation" element={<SpeechProviderListPage />} />
        <Route path="/settings/speech-generation/:providerId" element={<SpeechProviderSettingsPage />} />
        <Route path="/stickers" element={<StickersPage />} />
        <Route path="/stickers/remote" element={<StickerProviderListPage />} />
        <Route path="/stickers/remote/:providerId" element={<StickerProviderSettingsPage />} />
        <Route path="/profile/edit" element={<ProfileEditPage />} />
        <Route path="/modules" element={<ModulesPage />} />
        {moduleRoutes.map((r) => (
          <Route key={r.path} path={r.path} element={<r.Component />} />
        ))}
        {adminModeEnabled && (
          <>
            <Route path="/sky-eye" element={<SkyEyePage />} />
            <Route path="/ai-test-cards" element={<AiTestCardsPage />} />
            <Route path="/contact/:contactId/admin" element={<ContactAdminPage />} />
          </>
        )}
        </Routes>
    </Suspense>
  )

  return (
    <AppErrorBoundary resetKey={location.pathname}>
      <div className={`app-shell ${themeMode === 'dark' ? 'theme-dark' : ''}`} data-ui-theme={uiTheme} data-ui-scope="standard" data-desktop={desktop ? 'true' : undefined}>
        <NotificationBanner />
        <WebPrivacyNotice />
        {desktop ? <DesktopLayout>{routeContent}</DesktopLayout> : routeContent}
      </div>
    </AppErrorBoundary>
  )
}

export default App
