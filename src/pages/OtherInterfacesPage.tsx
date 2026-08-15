import { useRef, useState } from 'react'
import { TopBar } from '../components/TopBar'
import { ToggleSwitch } from '../components/ToggleSwitch'
import { useSettingsStore } from '../store/useSettingsStore'
import { useModuleEnabled } from '../features'
import { apiKeyFingerprint, randomAnimeAvatar, searchAnimeAvatar, testPexelsConnection } from '../lib/photoSearch'
import { tavilySearch } from '../lib/webSearch'
import { friendlyConnectionError } from '../lib/connectionError'
import { appFetch } from '../lib/appFetch'

const inputClass = 'w-full rounded-[var(--ui-radius-control)] border border-[var(--ui-border)] bg-[var(--ui-surface-2)] px-3 py-2.5 text-sm text-[var(--ui-text)] outline-none focus:border-[var(--ui-action)]'

export function OtherInterfacesPage() {
  const settings = useSettingsStore()
  const speechEnabled = useModuleEnabled('speech')
  const { setSettings } = settings
  const [tavilyKey, setTavilyKey] = useState(settings.tavilyApiKey)
  const [pexelsKey, setPexelsKey] = useState(settings.pexelsApiKey)
  const [visible, setVisible] = useState({ tavily: false, pexels: false })
  const [status, setStatus] = useState<{ kind: 'tavily' | 'pexels' | 'anime'; ok: boolean; text: string } | null>(null)
  const [testing, setTesting] = useState<'tavily' | 'pexels' | 'anime' | null>(null)
  const [animePreview, setAnimePreview] = useState<string>('')
  const [animeTag, setAnimeTag] = useState('')
  const downloadRef = useRef<HTMLAnchorElement | null>(null)

  async function testTavily() {
    setTesting('tavily'); setStatus(null)
    try {
      setSettings({ tavilyApiKey: tavilyKey.trim() })
      const results = await tavilySearch(tavilyKey.trim(), '今日天气')
      setStatus({ kind: 'tavily', ok: true, text: `连接成功，搜到 ${results.length} 条结果` })
    } catch (error) {
      setStatus({ kind: 'tavily', ok: false, text: friendlyConnectionError(error, 'Tavily') })
    } finally { setTesting(null) }
  }

  async function testPexels() {
    setTesting('pexels'); setStatus(null)
    try {
      await testPexelsConnection(pexelsKey.trim())
      setSettings({ pexelsApiKey: pexelsKey.trim() })
      setStatus({ kind: 'pexels', ok: true, text: `连接成功（${apiKeyFingerprint(pexelsKey)}）` })
    } catch (error) {
      setStatus({ kind: 'pexels', ok: false, text: friendlyConnectionError(error, 'Pexels') })
    } finally { setTesting(null) }
  }

  async function randomAnime() {
    setTesting('anime'); setStatus(null)
    try {
      const image = animeTag.trim()
        ? await searchAnimeAvatar(animeTag, settings.animeNsfwEnabled)
        : await randomAnimeAvatar(settings.animeNsfwEnabled)
      if (!image) throw new Error('动漫图库没有返回图片')
      setAnimePreview(image.url)
      setSettings({ albumSavedImages: [{ url: image.url, createdAt: Date.now(), source: '动漫图库', caption: animeTag.trim() || undefined }, ...(settings.albumSavedImages ?? []).filter((item) => item.url !== image.url)] })
      setStatus({ kind: 'anime', ok: true, text: animeTag.trim() ? '已找到一张匹配标签的图片' : settings.animeNsfwEnabled ? '已随机一张图片（可含成人内容）' : '已随机一张 SFW 图片' })
    } catch (error) {
      setStatus({ kind: 'anime', ok: false, text: friendlyConnectionError(error, 'Waifu.im') })
    } finally { setTesting(null) }
  }

  function setNsfw(enabled: boolean) {
    if (enabled && !window.confirm('成人内容可能包含裸露或性主题。确认你已达到所在地法定成年年龄，并要开启吗？')) return
    setSettings({ animeNsfwEnabled: enabled })
    setAnimePreview('')
  }

  async function downloadCurrent() {
    if (!animePreview) return
    try {
      const response = await appFetch(animePreview)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const objectUrl = URL.createObjectURL(await response.blob())
      const link = downloadRef.current ?? document.createElement('a')
      link.href = objectUrl
      link.download = `talk-anime-${Date.now()}.png`
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
    } catch (error) {
      setStatus({ kind: 'anime', ok: false, text: `保存失败：${friendlyConnectionError(error, '图片下载')}` })
    }
  }

  const result = (kind: 'tavily' | 'pexels' | 'anime') => status?.kind === kind ? (
    <p className={`mt-2 text-xs ${status.ok ? 'text-green-600' : 'text-red-500'}`}>{status.text}</p>
  ) : null

  return (
    <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[var(--ui-bg)]">
      <TopBar title="其他接口" showBack />
      <div className="flex-1 overflow-y-auto pb-8">
        <section className="border-b border-[var(--ui-border-soft)] bg-[var(--ui-surface)] px-4 pb-4 pt-5">
          <p className="text-xs font-medium text-[var(--ui-text-3)]">外部能力</p>
          <h1 className="ui-font-display mt-1 text-lg font-semibold text-[var(--ui-text)]">连接生成、图库与联网服务</h1>
          <p className="mt-2 text-xs leading-relaxed text-[var(--ui-text-3)]">先配置可用服务，再决定朋友圈和头像实际使用哪一种来源。</p>
        </section>

        <h2 className="px-4 pb-2 pt-5 text-xs font-medium text-[var(--ui-text-3)]">生成服务</h2>
        <section className="mx-4 overflow-hidden rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] shadow-[var(--ui-shadow)]">
          <a href="#/settings/image-generation" className="flex items-center justify-between gap-3 border-b border-[var(--ui-border-soft)] px-4 py-4"><span><span className="block text-[15px] text-[var(--ui-text)]">图片生成</span><span className="mt-1 block text-[11px] text-[var(--ui-text-3)]">Atlas、NovelAI、ComfyUI、Stable Diffusion 等</span></span><span className="text-[var(--ui-text-3)]">›</span></a>
          {speechEnabled && <a href="#/settings/speech-generation" className="flex items-center justify-between gap-3 px-4 py-4"><span><span className="block text-[15px] text-[var(--ui-text)]">语音生成</span><span className="mt-1 block text-[11px] text-[var(--ui-text-3)]">豆包语音、小米 MiMo</span></span><span className="text-[var(--ui-text-3)]">›</span></a>}
        </section>

        <h2 className="px-4 pb-2 pt-5 text-xs font-medium text-[var(--ui-text-3)]">图片来源</h2>
        <section className="mx-4 rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] px-4 shadow-[var(--ui-shadow)]">
          <details open className="border-b border-[var(--ui-border-soft)] py-4">
          <summary className="cursor-pointer list-none"><span className="flex items-center justify-between"><span><span className="block text-sm font-semibold text-[var(--ui-text)]">Pexels 实拍图库</span><span className="mt-1 block text-[11px] text-[var(--ui-text-3)]">用于真人头像和生活照片</span></span><span className={pexelsKey.trim() ? 'text-xs text-[var(--ui-success-ink)]' : 'text-xs text-[var(--ui-warning-ink)]'}>{pexelsKey.trim() ? '已填写' : '待配置'}</span></span></summary>
          <div className="mt-4">
          <div className="relative"><input value={pexelsKey} onChange={(e) => setPexelsKey(e.target.value)} onBlur={() => setSettings({ pexelsApiKey: pexelsKey.trim() })} type={visible.pexels ? 'text' : 'password'} placeholder="Pexels API Key" className={`${inputClass} pr-16`} /><button type="button" onClick={() => setVisible((v) => ({ ...v, pexels: !v.pexels }))} className="absolute inset-y-0 right-0 px-3 text-xs text-gray-500">{visible.pexels ? '隐藏' : '显示'}</button></div>
          <button type="button" onClick={() => void testPexels()} disabled={!pexelsKey.trim() || testing !== null} className="mt-2 w-full rounded-[var(--ui-radius-control)] bg-[var(--ui-action)] py-2.5 text-sm text-[var(--ui-on-action)] disabled:opacity-50">{testing === 'pexels' ? '测试中…' : '测试连接'}</button>
          {result('pexels')}
          </div></details>

          <details className="py-4">
          <summary className="cursor-pointer list-none"><span className="flex items-center justify-between"><span><span className="block text-sm font-semibold text-[var(--ui-text)]">动漫图库（Waifu.im）</span><span className="mt-1 block text-[11px] text-[var(--ui-text-3)]">搜索或随机获取动漫图片</span></span><span className="text-[var(--ui-text-3)]">⌄</span></span></summary>
          <div className="mt-3">
          <div className="flex items-center justify-between py-2"><div><p className="text-sm text-gray-900">允许 NSFW 内容</p><p className="mt-0.5 text-[11px] text-gray-400">默认仅 SFW；开启前须确认成年</p></div><ToggleSwitch checked={settings.animeNsfwEnabled} onChange={setNsfw} ariaLabel="允许 NSFW 内容" /></div>
          <input value={animeTag} onChange={(e) => setAnimeTag(e.target.value)} placeholder="按标签搜索：waifu、husbando、maid、neko；留空即随机" className={`${inputClass} mt-3`} />
          <button type="button" onClick={() => void randomAnime()} disabled={testing !== null} className="mt-2 w-full rounded-lg bg-gray-900 py-2.5 text-sm text-white disabled:opacity-50">{testing === 'anime' ? '获取中…' : animeTag.trim() ? '搜索动漫图' : '立即随机一张图'}</button>
          {animePreview && <><img src={animePreview} alt="随机动漫图预览" className="mt-3 aspect-square w-full rounded-xl object-cover" /><button type="button" onClick={() => void downloadCurrent()} className="mt-2 w-full rounded-lg bg-gray-100 py-2.5 text-sm text-gray-700">保存当前图片</button><p className="mt-1 text-[11px] text-gray-400">手机端会交由系统下载管理器保存。</p></>}
          {result('anime')}
          </div></details>
        </section>

        <h2 className="px-4 pb-2 pt-5 text-xs font-medium text-[var(--ui-text-3)]">实际使用方式</h2>
        <section className="mx-4 rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] px-4 py-4 shadow-[var(--ui-shadow)]">
          <label className="block text-sm text-[var(--ui-text)]">朋友圈自动配图<select value={settings.momentsImageSource} onChange={(e) => setSettings({ momentsImageSource: e.target.value as 'pexels' | 'anime' | 'generated' })} className={`${inputClass} mt-2`}><option value="pexels">Pexels 实拍图</option><option value="anime">随机动漫图</option><option value="generated">生图系统生成</option></select></label>
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--ui-text-3)]">缺少对应接口或生成失败时，朋友圈只发文字，不会改用其他来源。</p>
          <label className="mt-4 block border-t border-[var(--ui-border-soft)] pt-4 text-sm text-[var(--ui-text)]">头像自动配图<select value={settings.avatarImageSource} onChange={(e) => setSettings({ avatarImageSource: e.target.value as 'pexels' | 'anime' | 'generated' })} className={`${inputClass} mt-2`}><option value="pexels">Pexels 实拍图</option><option value="anime">随机动漫图</option><option value="generated">生图系统生成</option></select></label>
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--ui-text-3)]">用于新建联系人；已有联系人头像里的搜索和生成入口也会使用这里的来源。</p>
        </section>

        <h2 className="px-4 pb-2 pt-5 text-xs font-medium text-[var(--ui-text-3)]">联网搜索</h2>
        <section className="mx-4 rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] px-4 py-4 shadow-[var(--ui-shadow)]">
          <div className="mb-3 flex items-start justify-between gap-3"><div><h3 className="text-sm font-semibold text-[var(--ui-text)]">Tavily</h3><p className="mt-1 text-[11px] text-[var(--ui-text-3)]">为需要实时信息的功能提供联网检索</p></div><span className={tavilyKey.trim() ? 'text-xs text-[var(--ui-success-ink)]' : 'text-xs text-[var(--ui-warning-ink)]'}>{tavilyKey.trim() ? '已填写' : '待配置'}</span></div>
          <div className="relative"><input value={tavilyKey} onChange={(e) => setTavilyKey(e.target.value)} onBlur={() => setSettings({ tavilyApiKey: tavilyKey.trim() })} type={visible.tavily ? 'text' : 'password'} placeholder="tvly-..." className={`${inputClass} pr-16`} /><button type="button" onClick={() => setVisible((v) => ({ ...v, tavily: !v.tavily }))} className="absolute inset-y-0 right-0 px-3 text-xs text-gray-500">{visible.tavily ? '隐藏' : '显示'}</button></div>
          <button type="button" onClick={() => void testTavily()} disabled={!tavilyKey.trim() || testing !== null} className="mt-2 w-full rounded-[var(--ui-radius-control)] bg-[var(--ui-action)] py-2.5 text-sm text-[var(--ui-on-action)] disabled:opacity-50">{testing === 'tavily' ? '测试中…' : '测试连接'}</button>
          {result('tavily')}
        </section>
      </div>
      <a ref={downloadRef} className="hidden" />
    </div>
  )
}
