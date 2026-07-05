/**
 * Checks GitHub Releases for a newer tagged version than what's currently
 * installed. Deliberately NOT a true in-place silent updater — that would
 * need REQUEST_INSTALL_PACKAGES + downloading/triggering the Android
 * installer intent natively, which is a lot of native-side risk for a
 * personal project. What this *does* give "for free": since Android
 * treats installing a new APK with the same package id + signing as an
 * in-place upgrade (not a fresh install), a user tapping through to the
 * GitHub release page and installing the new APK manually keeps all their
 * local data (IndexedDB etc.) intact automatically — same as any normal
 * app update. This just removes the "did I check GitHub for a new
 * version" step.
 */
export interface UpdateCheckResult {
  hasUpdate: boolean
  latestVersion: string
  releaseUrl: string
}

const REPO = 'Entropy2077-axe/talk'

function parseVersion(tag: string): number[] {
  return tag
    .replace(/^v/i, '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0)
}

function isNewer(latest: number[], current: number[]): boolean {
  for (let i = 0; i < Math.max(latest.length, current.length); i++) {
    const l = latest[i] ?? 0
    const c = current[i] ?? 0
    if (l !== c) return l > c
  }
  return false
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
  if (!res.ok) {
    throw new Error(`检查更新失败 HTTP ${res.status}`)
  }
  const json = await res.json()
  const latestTag = typeof json?.tag_name === 'string' ? json.tag_name : ''
  const releaseUrl = typeof json?.html_url === 'string' ? json.html_url : `https://github.com/${REPO}/releases/latest`
  if (!latestTag) {
    throw new Error('未能获取最新版本信息')
  }
  return {
    hasUpdate: isNewer(parseVersion(latestTag), parseVersion(__APP_VERSION__)),
    latestVersion: latestTag,
    releaseUrl,
  }
}
