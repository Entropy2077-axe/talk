import { registerPlugin } from '@capacitor/core'

export interface InstallUpdateResult {
  status: 'installer-opened' | 'permission-required'
  downloadId: number
}

interface InAppUpdatePlugin {
  downloadAndInstall(options: { url: string; title: string }): Promise<InstallUpdateResult>
  installDownloaded(options: { downloadId: number }): Promise<InstallUpdateResult>
}

/** Android-only bridge. The OS installer always keeps the final confirmation step. */
export const InAppUpdate = registerPlugin<InAppUpdatePlugin>('InAppUpdate')
