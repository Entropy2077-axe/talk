import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { useSettingsStore } from './store/useSettingsStore'

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
// A real device report (Honor 60, Android 14, WebView stuck on Chromium 99
// — 4+ years out of date, likely because this China-market ROM has no Play
// Store to auto-update WebView the normal way) shows window.innerHeight,
// visualViewport.height, the computed --app-height, and .app-shell's own
// measured height all agreeing perfectly *even while the bottom nav is
// visibly missing* — so the JS-computed values aren't wrong, the WebView
// just isn't repainting .app-shell to match. That's consistent with a
// known class of old-Blink bugs where a CSS custom property changed via
// element.style.setProperty() doesn't reliably invalidate/repaint distant
// descendants that reference it through var() — .app-shell is several DOM
// levels below where --app-height gets set. Two defensive additions, both
// harmless on modern engines: set the value directly as an inline style on
// .app-shell itself (short-circuits the var() lookup chain entirely for
// the one element that matters most for this bug), and force a synchronous
// reflow right after so a stale layout can't linger.
function syncAppHeight() {
  const height = window.visualViewport?.height ?? window.innerHeight
  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;visibility:hidden;padding-top:env(safe-area-inset-top,0px)'
  document.body.appendChild(probe)
  const safeTop = Number.parseFloat(getComputedStyle(probe).paddingTop) || 0
  probe.remove()
  const manualTop = Math.max(0, Math.min(80, useSettingsStore.getState().topInsetAdjustmentPx || 0))
  const top = safeTop + manualTop
  const appHeight = Math.max(240, height - top)
  document.documentElement.style.setProperty('--app-top-offset', `${top}px`)
  document.documentElement.style.setProperty('--app-height', `${appHeight}px`)
  const root = document.getElementById('root')
  if (root) {
    // Apply the compensation to the actual layout root as well. Older
    // Android WebViews can keep a descendant's paint stale after only a
    // custom-property/margin update; an inline root padding change forces the
    // whole app tree to re-layout, so the manual setting is visibly effective.
    root.style.boxSizing = 'border-box'
    root.style.paddingTop = `${top}px`
  }
  const shell = document.querySelector<HTMLElement>('.app-shell')
  if (shell) {
    shell.style.marginTop = '0px'
    shell.style.height = `${appHeight}px`
  }
  void document.body.offsetHeight // force a reflow, in case the property change alone doesn't trigger one
}
syncAppHeight()
window.addEventListener('resize', syncAppHeight)
window.addEventListener('orientationchange', syncAppHeight)
window.addEventListener('talk:system-ui-change', syncAppHeight)
window.visualViewport?.addEventListener('resize', syncAppHeight)
useSettingsStore.subscribe((state, previous) => {
  if (state.topInsetAdjustmentPx !== previous.topInsetAdjustmentPx) syncAppHeight()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
)

// .app-shell doesn't exist yet the first time syncAppHeight() ran above (React
// hasn't rendered it), so its inline-style fallback got skipped on that call —
// re-run it once mounted so the very first paint gets the fallback too, not
// just whatever resize/keyboard event happens to fire next. Belt-and-braces
// with both rAF and a short timeout rather than trusting either mechanism
// alone to fire before something checks/relies on the result.
requestAnimationFrame(syncAppHeight)
setTimeout(syncAppHeight, 100)
