import { spawn } from 'node:child_process'

const baseUrl = 'http://127.0.0.1:5173'
const isWindows = process.platform === 'win32'

function command(name) {
  return isWindows ? `${name}.cmd` : name
}

async function isServerReady() {
  try {
    const res = await fetch(baseUrl)
    return res.ok
  } catch {
    return false
  }
}

async function waitForServer() {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (await isServerReady()) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Timed out waiting for ${baseUrl}`)
}

function spawnInherited(cmd, args) {
  return spawn(cmd, args, {
    cwd: process.cwd(),
    env: process.env,
    shell: isWindows,
    stdio: 'inherit',
  })
}

let server
if (!(await isServerReady())) {
  server = spawnInherited(command('npm'), ['run', 'dev', '--', '--host', '127.0.0.1'])
  await waitForServer()
}

const testProcess = spawnInherited(command('playwright'), ['test'])
testProcess.on('exit', (code) => {
  if (server) server.kill()
  process.exit(code ?? 1)
})
