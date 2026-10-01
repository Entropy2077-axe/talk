import { useEffect, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { Fullscreen } from '@boengli/capacitor-fullscreen'
import { Maximize, Minimize } from 'lucide-react'
// The Android plugin does not expose a status query. Keep the state at module
// scope so it survives navigating away from and back to the Me tab while the
// current WebView process is alive.
let androidFullscreenActive = false

function refreshViewportAfterSystemUiChange() {
  const notify = () => window.dispatchEvent(new Event('talk:system-ui-change'))
  notify()
  // Android applies window-inset and cutout changes asynchronously. Measure
  // once after layout and once after the system-bar animation has settled.
  requestAnimationFrame(() => requestAnimationFrame(notify))
  window.setTimeout(notify, 200)
}


export function FullscreenControl() {
  const [isFullscreen, setIsFullscreen] = useState(() =>
    Capacitor.getPlatform() === 'android' ? androidFullscreenActive : Boolean(document.fullscreenElement),
  )
  const [fullscreenError, setFullscreenError] = useState('')

  useEffect(() => {
    const syncFullscreenState = () => {
      setIsFullscreen(Boolean(document.fullscreenElement))
      setFullscreenError('')
    }
    document.addEventListener('fullscreenchange', syncFullscreenState)
    return () => document.removeEventListener('fullscreenchange', syncFullscreenState)
  }, [])

  async function handleFullscreen() {
    setFullscreenError('')
    try {
      if (Capacitor.getPlatform() === 'android') {
        if (androidFullscreenActive) {
          await Fullscreen.deactivateImmersiveMode()
          androidFullscreenActive = false
        } else {
          await Fullscreen.activateImmersiveMode()
          androidFullscreenActive = true
        }
        setIsFullscreen(androidFullscreenActive)
        refreshViewportAfterSystemUiChange()
      } else if (document.fullscreenElement) {
        await document.exitFullscreen()
      } else {
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' })
      }
    } catch {
      setFullscreenError('当前环境不支持全屏')
    }
  }


  return <section className="ui-list-card ui-section-spaced"><button type="button" onClick={() => void handleFullscreen()} className="ui-list-row w-full"><span className="flex items-center gap-3">{isFullscreen ? <Minimize size={20} /> : <Maximize size={20} />}<span>{isFullscreen ? '退出全屏' : '进入全屏'}</span></span></button>{fullscreenError && <p role="status" className="px-4 pb-3 text-xs text-[var(--ui-danger-ink)]">{fullscreenError}</p>}</section>
}
