import { registerPlugin } from '@capacitor/core'

interface BackupDirectoryPlugin {
  /** Writes the large backup payload before the system document picker opens. */
  stage(options: { contents: string }): Promise<{ token: string }>
  /** Opens Android's standard "Save as" picker for a staged backup. */
  saveStaged(options: { token: string; filename: string }): Promise<{ uri: string }>
}

export const BackupDirectory = registerPlugin<BackupDirectoryPlugin>('BackupDirectory')
