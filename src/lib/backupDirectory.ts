import { registerPlugin } from '@capacitor/core'

interface BackupDirectoryPlugin {
  /**
   * Prompts for a folder only when one has not been selected before. The
   * native side retains Android's SAF grant, so later backups go there
   * without another prompt.
   */
  save(options: { filename: string; contents: string }): Promise<{ uri: string }>
}

export const BackupDirectory = registerPlugin<BackupDirectoryPlugin>('BackupDirectory')
