import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../dist/', import.meta.url))
const secretPatterns = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /tvly-[A-Za-z0-9_-]{20,}/g,
]

async function files(dir) {
  const result = []
  for (const name of await readdir(dir)) {
    const path = join(dir, name)
    if ((await stat(path)).isDirectory()) result.push(...await files(path))
    else result.push(path)
  }
  return result
}

const matches = []
for (const file of await files(root)) {
  const content = await readFile(file).catch(() => null)
  if (!content) continue
  const text = content.toString('utf8')
  for (const pattern of secretPatterns) {
    const found = text.match(pattern)
    if (found) matches.push(`${file}: ${found.map((v) => `${v.slice(0, 7)}…`).join(', ')}`)
  }
}

if (matches.length) {
  console.error(`Potential API keys found in dist:\n${matches.join('\n')}`)
  process.exit(1)
}
console.log('dist secret scan passed')
