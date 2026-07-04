import { Route, Routes } from 'react-router-dom'
import { TabLayout } from './components/TabLayout'
import { MessagesPage } from './pages/MessagesPage'
import { ContactsPage } from './pages/ContactsPage'
import { DiscoverPage } from './pages/DiscoverPage'
import { MePage } from './pages/MePage'
import { ChatPage } from './pages/ChatPage'
import { ContactCardPage } from './pages/ContactCardPage'
import { ContactEditPage } from './pages/ContactEditPage'
import { SettingsPage } from './pages/SettingsPage'
import { StickersPage } from './pages/StickersPage'

function App() {
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
        <Route path="/contact/new" element={<ContactEditPage />} />
        <Route path="/contact/:contactId" element={<ContactCardPage />} />
        <Route path="/contact/:contactId/edit" element={<ContactEditPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/stickers" element={<StickersPage />} />
      </Routes>
    </div>
  )
}

export default App
