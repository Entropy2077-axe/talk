import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.talk.aichat',
  appName: 'Talk',
  webDir: 'dist',
  android: {
    // ComfyUI and Stable Diffusion WebUI commonly run over plain HTTP on
    // the user's LAN. Only explicitly configured URLs are requested.
    allowMixedContent: true,
  },
}

export default config
