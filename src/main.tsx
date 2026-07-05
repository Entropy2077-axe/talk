import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'

// See the --app-height comment in index.css: some Android WebViews don't
// size 100dvh/100vh correctly against the real visible area, so the actual
// layout height is measured in JS and exposed as a CSS variable instead.
//
// Prefer visualViewport.height over window.innerHeight: when the on-screen
// keyboard opens, many mobile WebViews (this one included, per a real user
// report — the todo-add input focusing the keyboard made the bottom nav
// disappear) keep the *layout* viewport unchanged and just overlay the
// keyboard on top, so window.innerHeight/its resize event never reflects
// the keyboard at all. visualViewport tracks the actually-visible area and
// fires its own resize event when the keyboard shows/hides, so syncing off
// it shrinks --app-height correctly and keeps the bottom nav above the
// keyboard instead of hidden behind it.
function syncAppHeight() {
  const height = window.visualViewport?.height ?? window.innerHeight
  document.documentElement.style.setProperty('--app-height', `${height}px`)
}
syncAppHeight()
window.addEventListener('resize', syncAppHeight)
window.addEventListener('orientationchange', syncAppHeight)
window.visualViewport?.addEventListener('resize', syncAppHeight)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
)
