import { Route, Routes } from 'react-router-dom'
import { TabLayout } from './components/TabLayout'
import { MessagesPage } from './pages/MessagesPage'
import { ContactsPage } from './pages/ContactsPage'
import { DiscoverPage } from './pages/DiscoverPage'
import { MePage } from './pages/MePage'
import { ChatPage } from './pages/ChatPage'
import { ContactCardPage } from './pages/ContactCardPage'
import { ContactAddPage } from './pages/ContactAddPage'
import { TodoPage } from './pages/TodoPage'
import { RelationshipsPage } from './pages/RelationshipsPage'
import { ShopPage } from './pages/ShopPage'
import { WarehousePage } from './pages/WarehousePage'
import { SettingsPage } from './pages/SettingsPage'
import { StickersPage } from './pages/StickersPage'
import { ProfileEditPage } from './pages/ProfileEditPage'

function App() {
  return (
    <div className="app-shell">
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
        <Route path="/relationships" element={<RelationshipsPage />} />
        <Route path="/shop" element={<ShopPage />} />
        <Route path="/warehouse" element={<WarehousePage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/stickers" element={<StickersPage />} />
        <Route path="/profile/edit" element={<ProfileEditPage />} />
      </Routes>
    </div>
  )
}

export default App
