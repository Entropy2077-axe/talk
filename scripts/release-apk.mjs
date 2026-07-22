import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const envPath = join(root, '.env')
const androidDir = join(root, 'android')
const apkPath = join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
const androidBuildGradlePath = join(androidDir, 'app', 'build.gradle')
const androidManifestPath = join(androidDir, 'app', 'src', 'main', 'AndroidManifest.xml')
const defaultJavaHome = 'C:\\Projects\\AndroidStudio\\jbr'

const args = new Set(process.argv.slice(2))

function usage() {
  console.log(`Usage: npm run release:apk

Builds a debug APK for release without baking local API keys into the bundle.

Steps:
  1. Back up .env in memory
  2. Replace VITE_* values with empty release values
  3. Run npm build, Capacitor sync, and Gradle assembleDebug
  4. Restore the original .env even if a step fails
  5. Unpack the APK and scan for original non-empty .env values

Options:
  --help       Show this message
  --skip-apk   Build web assets and run Capacitor sync, but skip Gradle
`)
}

if (args.has('--help') || args.has('-h')) {
  usage()
  process.exit(0)
}

function log(message) {
  console.log(`[release-apk] ${message}`)
}

function fail(message) {
  console.error(`[release-apk] ${message}`)
  process.exit(1)
}

function command(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name
}

function run(cmd, cmdArgs, options = {}) {
  log(`Running: ${cmd} ${cmdArgs.join(' ')}`)
  const result = spawnSync(cmd, cmdArgs, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${cmd} exited with status ${result.status}`)
  }
}

function parseEnv(content) {
  const values = new Map()
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const index = line.indexOf('=')
    if (index <= 0) continue
    values.set(line.slice(0, index), line.slice(index + 1))
  }
  return values
}

function valuesToScan(envContent) {
  const placeholders = new Set(['your_api_key_here', 'your_tavily_api_key_here', 'your_pexels_api_key_here'])
  const values = []
  for (const [key, value] of parseEnv(envContent)) {
    const trimmed = value.trim()
    if (!key.startsWith('VITE_')) continue
    if (!trimmed || placeholders.has(trimmed)) continue
    if (key.endsWith('_BASE_URL')) continue
    if (trimmed.length < 8) continue
    values.push({ key, value: trimmed })
  }
  return values
}

function emptyReleaseEnv(originalContent) {
  const knownKeys = new Set([
    'VITE_DEEPSEEK_API_KEY',
    'VITE_DEEPSEEK_BASE_URL',
    'VITE_TAVILY_API_KEY',
    'VITE_PEXELS_API_KEY',
  ])
  for (const key of parseEnv(originalContent).keys()) {
    if (key.startsWith('VITE_')) knownKeys.add(key)
  }
  return `${[...knownKeys].sort().map((key) => `${key}=`).join('\n')}\n`
}

function syncAndroidVersionFromPackage() {
  if (!existsSync(androidBuildGradlePath)) throw new Error(`Missing Android build file: ${androidBuildGradlePath}`)
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const version = String(packageJson.version ?? '').trim()
  const parts = version.split('.').map((part) => Number.parseInt(part, 10))
  if (!/^\d+\.\d+\.\d+$/.test(version) || parts.some((part) => !Number.isInteger(part))) {
    throw new Error(`package.json version must be numeric semver, received: ${version || '(empty)'}`)
  }
  const versionCode = parts[0] * 10000 + parts[1] * 100 + parts[2]
  let gradle = readFileSync(androidBuildGradlePath, 'utf8')
  if (!/versionCode\s+\d+/.test(gradle) || !/versionName\s+"[^"]+"/.test(gradle)) {
    throw new Error('Could not find versionCode/versionName in android/app/build.gradle')
  }
  gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`)
  gradle = gradle.replace(/versionName\s+"[^"]+"/, `versionName "${version}"`)
  writeFileSync(androidBuildGradlePath, gradle, 'utf8')
  log(`Synced Android versionName=${version}, versionCode=${versionCode}.`)
}

function ensureAndroidLocalHttpSupport() {
  if (!existsSync(androidManifestPath)) throw new Error(`Missing Android manifest: ${androidManifestPath}`)
  let manifest = readFileSync(androidManifestPath, 'utf8')
  if (/android:usesCleartextTraffic=/.test(manifest)) {
    manifest = manifest.replace(/android:usesCleartextTraffic="[^"]*"/, 'android:usesCleartextTraffic="true"')
  } else {
    manifest = manifest.replace(/<application\b/, '<application android:usesCleartextTraffic="true"')
  }
  writeFileSync(androidManifestPath, manifest, 'utf8')
  log('Enabled user-configured LAN HTTP providers for Android.')
}

function readAndroidSdkDir() {
  const localProperties = join(androidDir, 'local.properties')
  if (!existsSync(localProperties)) return undefined
  const content = readFileSync(localProperties, 'utf8')
  const match = content.match(/^sdk\.dir=(.+)$/m)
  if (!match) return undefined
  return match[1].replace(/\\\\/g, '\\').replace(/\\:/g, ':')
}

function listFiles(dir) {
  const files = []
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry)
    const stat = statSync(fullPath)
    if (stat.isDirectory()) {
      files.push(...listFiles(fullPath))
    } else {
      files.push(fullPath)
    }
  }
  return files
}

function scanDirectoryForValues(dir, values) {
  const hits = []
  const encoded = values.map((item) => ({ ...item, buffer: Buffer.from(item.value) }))
  for (const file of listFiles(dir)) {
    const content = readFileSync(file)
    for (const item of encoded) {
      if (content.includes(item.buffer)) {
        hits.push({ key: item.key, file })
      }
    }
  }
  return hits
}

function unpackApkForScan(apk, javaHome) {
  const jarExe = process.platform === 'win32' ? join(javaHome, 'bin', 'jar.exe') : join(javaHome, 'bin', 'jar')
  if (!existsSync(jarExe)) {
    throw new Error(`Cannot find jar executable at ${jarExe}`)
  }
  const outDir = mkdtempSync(join(tmpdir(), 'talk-apk-scan-'))
  run(jarExe, ['xf', apk], { cwd: outDir })
  return outDir
}

function main() {
  if (!existsSync(envPath)) fail('Missing .env. Create it from .env.example before releasing.')
  if (!existsSync(androidDir)) fail('Missing android/ directory. Run npx cap add android first.')

  const originalEnv = readFileSync(envPath, 'utf8')
  const scanValues = valuesToScan(originalEnv)
  const javaHome = process.env.JAVA_HOME || defaultJavaHome
  const androidHome = process.env.ANDROID_HOME || readAndroidSdkDir()

  if (!existsSync(javaHome)) fail(`JAVA_HOME not found: ${javaHome}`)
  if (!androidHome || !existsSync(androidHome)) fail(`ANDROID_HOME not found: ${androidHome ?? '(not configured)'}`)

  log(`Using JAVA_HOME=${javaHome}`)
  log(`Using ANDROID_HOME=${androidHome}`)
  log(`Prepared ${scanValues.length} sensitive value(s) for post-build leak scan.`)

  try {
    writeFileSync(envPath, emptyReleaseEnv(originalEnv), 'utf8')
    log('Temporarily replaced .env with empty release values.')

    syncAndroidVersionFromPackage()
    run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/sync-android-icon.ps1'])
    run(command('npm'), ['run', 'build'])
    run(command('npx'), ['cap', 'sync', 'android'])
    ensureAndroidLocalHttpSupport()

    if (!args.has('--skip-apk')) {
      const gradle = process.platform === 'win32' ? 'gradlew.bat' : './gradlew'
      run(join(androidDir, gradle), ['assembleDebug'], {
        cwd: androidDir,
        env: {
          JAVA_HOME: javaHome,
          ANDROID_HOME: androidHome,
        },
      })

      if (!existsSync(apkPath)) throw new Error(`Expected APK was not created: ${apkPath}`)

      if (scanValues.length > 0) {
        const unpackedDir = unpackApkForScan(apkPath, javaHome)
        try {
          const hits = scanDirectoryForValues(unpackedDir, scanValues)
          if (hits.length > 0) {
            const summary = hits.map((hit) => `${hit.key} in ${basename(hit.file)}`).join(', ')
            throw new Error(`Sensitive value leak detected: ${summary}`)
          }
          log('Sensitive value scan passed.')
        } finally {
          rmSync(unpackedDir, { recursive: true, force: true })
        }
      } else {
        log('No non-empty local API keys found to scan for.')
      }

      log(`APK ready: ${apkPath}`)
      const apkStat = statSync(apkPath)
      const apkSizeMB = (apkStat.size / (1024 * 1024)).toFixed(2)
      const apkSha256 = createHash('sha256').update(readFileSync(apkPath)).digest('hex')
      log(`  Size: ${apkSizeMB} MB`)
      log(`  SHA256: ${apkSha256}`)
    } else {
      log('Skipped Gradle APK build because --skip-apk was provided.')
    }
  } finally {
    writeFileSync(envPath, originalEnv, 'utf8')
    log('Restored original .env.')
  }
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
