import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.talk.aichat',
  appName: 'Talk',
  webDir: 'dist',
  plugins: {
    // Route fetch/XMLHttpRequest through Android's native HTTP stack in the
    // packaged app. This keeps browser behavior unchanged while allowing the
    // APK to call providers such as NVIDIA whose APIs do not enable CORS.
    CapacitorHttp: {
      enabled: true,
    },
    Fullscreen: {
      // Fullscreen is an explicit button on the "Me" page, never forced at launch.
      activateOnLoad: false,
    },
  },
  android: {
    // ComfyUI and Stable Diffusion WebUI commonly run over plain HTTP on
    // the user's LAN. Only explicitly configured URLs are requested.
    allowMixedContent: true,
  },
}

export default config
