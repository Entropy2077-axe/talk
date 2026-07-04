import { useEffect } from 'react'
import { Route, Routes } from 'react-router-dom'
import { TabLayout } from './components/TabLayout'
import { MessagesPage } from './pages/MessagesPage'
import { ContactsPage } from './pages/ContactsPage'
import { DiscoverPage } from './pages/DiscoverPage'
import { MePage } from './pages/MePage'
import { ChatPage } from './pages/ChatPage'
import { ContactCardPage } from './pages/ContactCardPage'
import { ContactAddPage } from './pages/ContactAddPage'
import { ContactSchedulePage } from './pages/ContactSchedulePage'
import { RelationshipsPage } from './pages/RelationshipsPage'
import { MapPage } from './pages/MapPage'
import { SettingsPage } from './pages/SettingsPage'
import { StickersPage } from './pages/StickersPage'
import { ProfileEditPage } from './pages/ProfileEditPage'
import { ensurePresetLocations } from './lib/locations'
import { useSettingsStore } from './store/useSettingsStore'
import { db } from './db/db'

function App() {
  const { userLocationId, setSettings } = useSettingsStore()

  useEffect(() => {
    ensurePresetLocations().then(async () => {
      if (userLocationId) return
      const home = await db.locations.where('name').equals('家里').first()
      if (home) setSettings({ userLocationId: home.id })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="app-shell">
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
        <Route path="/contact/:contactId/schedule" element={<ContactSchedulePage />} />
        <Route path="/relationships" element={<RelationshipsPage />} />
        <Route path="/map" element={<MapPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/stickers" element={<StickersPage />} />
        <Route path="/profile/edit" element={<ProfileEditPage />} />
      </Routes>
    </div>
  )
}

export default App
