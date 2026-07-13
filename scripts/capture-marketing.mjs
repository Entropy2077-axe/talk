import { chromium } from 'playwright'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const baseURL = process.env.TALK_BASE_URL ?? 'http://127.0.0.1:5173'
const outDir = resolve('docs/assets/screenshots')
const assetsDir = resolve('docs/assets')
await mkdir(outDir, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 })
await page.goto(`${baseURL}/#/`)

await page.evaluate(async () => {
  localStorage.setItem('talk-web-privacy-notice-dismissed', '1')
  const { db } = await import('/src/db/db.ts')
  const { useSettingsStore } = await import('/src/store/useSettingsStore.ts')
  for (const table of db.tables) await table.clear()
  useSettingsStore.getState().setSettings({
    apiKey: '',
    userNickname: '小屿',
    themeMode: 'light',
    animationsEnabled: false,
    chatBackground: '',
  })

  const now = Date.now()
  const base = {
    systemPrompt: '仅用于公开产品截图的虚构演示角色。',
    createdAt: now - 30 * 86400000,
    memoryFacts: '用户最近在准备一次旅行，也喜欢夜晚散步。',
    memoryStyle: '熟悉、自然，会记得细节但不过度追问。',
    memoryUpdatedAt: now,
    memoryMessageCursor: 8,
    relationshipBase: '朋友',
    relationshipDynamic: '已经很熟悉，偶尔互相打趣，也会认真关心对方。',
  }
  await db.contacts.bulkAdd([
    { ...base, id: 'lin', name: '林晚', avatar: '🌙', avatarColor: '#e8e5ff', warmth: 72, occupation: '独立摄影师', mbti: 'INFP' },
    { ...base, id: 'xia', name: '夏弥', avatar: '🍊', avatarColor: '#fff0d8', warmth: 58, occupation: '咖啡师', mbti: 'ENFP' },
    { ...base, id: 'zhou', name: '周屿', avatar: '🎧', avatarColor: '#dfefff', warmth: 46, occupation: '游戏策划', mbti: 'INTP' },
  ])
  await db.groups.add({
    id: 'weekend', name: '周末出逃计划', avatar: '🚗', avatarColor: '#e5f7ef',
    memberContactIds: ['lin', 'xia', 'zhou'], vibe: '熟人间轻松、会互相接梗的旅行群',
    speakerLimit: 3, allowAiChatter: true, energyLevel: 'lively', createdAt: now - 86400000, memoryMessageCursor: 0,
  })
  await db.conversations.bulkAdd([
    { id: 'chat-lin', contactId: 'lin', pinned: true, createdAt: now - 200000, updatedAt: now - 1000, lastReadAt: now },
    { id: 'chat-xia', contactId: 'xia', pinned: false, createdAt: now - 180000, updatedAt: now - 80000 },
    { id: 'chat-group', groupId: 'weekend', pinned: false, createdAt: now - 160000, updatedAt: now - 40000, lastReadAt: now },
  ])
  await db.messages.bulkAdd([
    { id: 'm1', conversationId: 'chat-lin', role: 'user', type: 'text', content: '今天终于把方案交了，脑子已经空了', createdAt: now - 180000 },
    { id: 'm2', conversationId: 'chat-lin', role: 'assistant', type: 'text', content: '难怪你下午一直没回消息', createdAt: now - 170000 },
    { id: 'm3', conversationId: 'chat-lin', role: 'assistant', type: 'text', content: '先别复盘了，去楼下走十分钟？你上次说吹点风会舒服很多', createdAt: now - 160000 },
    { id: 'm4', conversationId: 'chat-lin', role: 'user', type: 'text', content: '被你记住了……那你陪我聊会儿', createdAt: now - 120000 },
    { id: 'm5', conversationId: 'chat-lin', role: 'assistant', type: 'text', content: '行啊。你走你的，我在这边给你当夜间电台', createdAt: now - 100000 },
    { id: 'x1', conversationId: 'chat-xia', role: 'assistant', type: 'text', content: '今天店里试了新的橙香拿铁，下次给你留一杯', createdAt: now - 80000 },
    { id: 'g1', conversationId: 'chat-group', role: 'user', type: 'text', content: '周六到底去哪，三位给个准话', createdAt: now - 70000 },
    { id: 'g2', conversationId: 'chat-group', role: 'assistant', type: 'text', content: '我投海边。下午光线好，顺便给你们拍照。', speakerContactId: 'lin', bubbleGroupId: 'turn1', createdAt: now - 65000 },
    { id: 'g3', conversationId: 'chat-group', role: 'assistant', type: 'text', content: '海边可以！但我要先声明，谁迟到谁请喝东西。', speakerContactId: 'xia', bubbleGroupId: 'turn1', createdAt: now - 60000 },
    { id: 'g4', conversationId: 'chat-group', role: 'assistant', type: 'text', content: '路线发群公告了。以及根据历史数据，最可能迟到的是夏弥。', speakerContactId: 'zhou', bubbleGroupId: 'turn1', createdAt: now - 55000 },
    { id: 'g5', conversationId: 'chat-group', role: 'assistant', type: 'text', content: '周屿你撤回，我看见了 😤', speakerContactId: 'xia', bubbleGroupId: 'turn1', createdAt: now - 50000 },
  ])
  await db.moments.bulkAdd([
    { id: 'm-lin', contactId: 'lin', content: '收工路上遇到一小片很温柔的晚霞。今天可以不那么用力。', createdAt: now - 3600000 },
    { id: 'm-xia', contactId: 'xia', content: '新豆子测试成功 ☕ 下次抓一个熟人来当第一位客人。', createdAt: now - 7200000 },
    { id: 'm-zhou', contactId: 'zhou', content: '把周末路线排完了。某些人最好不要再临出门才找充电宝。', createdAt: now - 10800000 },
  ])
  await db.momentLikes.bulkAdd([
    { id: 'l1', momentId: 'm-lin', likerId: 'xia', createdAt: now - 3400000 },
    { id: 'l2', momentId: 'm-lin', likerId: 'zhou', createdAt: now - 3300000 },
    { id: 'l3', momentId: 'm-xia', likerId: 'lin', createdAt: now - 7000000 },
  ])
  await db.momentComments.bulkAdd([
    { id: 'c1', momentId: 'm-lin', authorContactId: 'xia', content: '这句话我先收藏，明天忙起来的时候还给你。', createdAt: now - 3200000 },
    { id: 'c2', momentId: 'm-lin', authorContactId: 'zhou', content: '照片呢？摄影师不能只交文案。', createdAt: now - 3100000 },
    { id: 'c3', momentId: 'm-xia', authorContactId: 'zhou', content: '“熟人”听起来像免费测试员。', createdAt: now - 6800000 },
  ])
})

await page.reload()
await page.waitForTimeout(500)

async function shot(name, hash) {
  await page.goto(`${baseURL}/#${hash}`)
  await page.waitForTimeout(400)
  await page.screenshot({ path: resolve(outDir, `${name}.png`) })
}

await shot('chat', '/chat/chat-lin')
await shot('moments', '/moments')
await shot('contacts', '/contacts')
await shot('group-chat', '/chat/chat-group')
await shot('contact-create', '/contact/new')
await shot('modules', '/modules')

const encode = async (name) => `data:image/png;base64,${(await readFile(resolve(outDir, `${name}.png`))).toString('base64')}`
const chat = await encode('chat')
const moments = await encode('moments')
const group = await encode('group-chat')

await page.setViewportSize({ width: 1280, height: 640 })
await page.setContent(`<!doctype html><html><style>
*{box-sizing:border-box}body{margin:0;background:#f4f8f5;font-family:Inter,"Microsoft YaHei",sans-serif;color:#17201b;overflow:hidden}.canvas{width:1280px;height:640px;position:relative;padding:68px 72px;background:radial-gradient(circle at 88% 10%,#c9f4d8 0,transparent 32%),radial-gradient(circle at 12% 95%,#dfe8ff 0,transparent 35%),#f7faf8}.copy{width:570px;position:relative;z-index:3}.brand{display:flex;align-items:center;gap:14px;font-size:24px;font-weight:700;color:#087f42}.logo{width:54px;height:54px;border-radius:15px;background:#07c160;color:white;display:grid;place-items:center;font-size:30px;box-shadow:0 12px 30px #07c16033}.eyebrow{margin-top:60px;font-size:18px;color:#34805a;font-weight:600}.title{font-size:58px;line-height:1.16;letter-spacing:-2px;margin:16px 0 18px}.sub{font-size:22px;line-height:1.7;color:#536159;max-width:530px}.pills{display:flex;gap:10px;margin-top:28px}.pill{padding:9px 14px;background:#fff;border:1px solid #dce9e0;border-radius:999px;font-size:15px;color:#3f5146}.phones{position:absolute;right:54px;top:40px;width:610px;height:560px}.phone{position:absolute;width:245px;height:530px;border:7px solid #17201b;border-radius:34px;overflow:hidden;background:white;box-shadow:0 28px 60px #193d2929}.phone img{width:100%;height:100%;object-fit:cover}.p1{left:40px;top:32px;transform:rotate(-5deg)}.p2{left:205px;top:0;z-index:2;transform:rotate(1deg)}.p3{left:370px;top:38px;transform:rotate(6deg)}</style><body><div class="canvas"><div class="copy"><div class="brand"><div class="logo">聊</div>Talk</div><div class="eyebrow">本地优先 · DeepSeek 驱动 · Android / Web</div><h1 class="title">像微信一样聊天<br>让 AI 记得你</h1><div class="sub">联系人会积累记忆与关系，也会拥有朋友圈、群聊和自己的生活。</div><div class="pills"><span class="pill">长期记忆</span><span class="pill">关系成长</span><span class="pill">AI 朋友圈</span></div></div><div class="phones"><div class="phone p1"><img src="${moments}"></div><div class="phone p2"><img src="${chat}"></div><div class="phone p3"><img src="${group}"></div></div></div></body></html>`)
await page.screenshot({ path: resolve(assetsDir, 'talk-social-preview.png') })

await page.setViewportSize({ width: 1200, height: 900 })
await page.setContent(`<!doctype html><html><style>*{box-sizing:border-box}body{margin:0;background:#eef4f0;font-family:Inter,"Microsoft YaHei",sans-serif}.c{width:1200px;height:900px;padding:50px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:28px}.item{background:white;border-radius:26px;padding:22px;box-shadow:0 14px 35px #193d2918}.item img{width:100%;height:720px;object-fit:cover;object-position:top;border-radius:18px;border:1px solid #e5e7eb}.item p{text-align:center;margin:16px 0 0;font-size:22px;font-weight:650;color:#24352b}</style><body><div class="c"><div class="item"><img src="${chat}"><p>会记住细节的聊天</p></div><div class="item"><img src="${moments}"><p>会互动的 AI 朋友圈</p></div><div class="item"><img src="${group}"><p>真正有角色关系的群聊</p></div></div></body></html>`)
await page.screenshot({ path: resolve(assetsDir, 'talk-feature-collage.png') })

await browser.close()
console.log(`Marketing screenshots written to ${assetsDir}`)
