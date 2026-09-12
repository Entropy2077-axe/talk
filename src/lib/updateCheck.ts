/** Finds a newer GitHub Release and its APK asset when one is attached. */
import { appFetch } from './appFetch'

export interface UpdateCheckResult {
  hasUpdate: boolean
  latestVersion: string
  releaseUrl: string
  apkUrl?: string
  apkName?: string
  apkSize?: number
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
  const res = await appFetch(`https://api.github.com/repos/${REPO}/releases/latest`)
  if (!res.ok) {
    throw new Error(`检查更新失败 HTTP ${res.status}`)
  }
  const json = await res.json()
  const latestTag = typeof json?.tag_name === 'string' ? json.tag_name : ''
  const releaseUrl = typeof json?.html_url === 'string' ? json.html_url : `https://github.com/${REPO}/releases/latest`
  const apkAsset = Array.isArray(json?.assets)
    ? json.assets.find((asset: unknown) => {
        if (!asset || typeof asset !== 'object') return false
        const candidate = asset as { name?: unknown; browser_download_url?: unknown }
        return typeof candidate.name === 'string'
          && /\.apk$/i.test(candidate.name)
          && typeof candidate.browser_download_url === 'string'
      }) as { name?: string; browser_download_url?: string; size?: number } | undefined
    : undefined
  if (!latestTag) {
    throw new Error('未能获取最新版本信息')
  }
  return {
    hasUpdate: isNewer(parseVersion(latestTag), parseVersion(__APP_VERSION__)),
    latestVersion: latestTag,
    releaseUrl,
    apkUrl: apkAsset?.browser_download_url,
    apkName: apkAsset?.name,
    apkSize: typeof apkAsset?.size === 'number' ? apkAsset.size : undefined,
  }
}
