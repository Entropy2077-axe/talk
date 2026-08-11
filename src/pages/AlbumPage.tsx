import { useState } from 'react'
import { Download, Trash2, X } from 'lucide-react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { useSettingsStore } from '../store/useSettingsStore'

type AlbumSource = '动漫图库' | 'Pexels 实拍图' | '生图系统'

interface AlbumImage {
  url: string
  createdAt: number
  source: AlbumSource
  caption?: string
}
const EMPTY_LIST: never[] = []

function sourceFor(url: string, explicit?: string, photographer?: string): AlbumSource {
  if (explicit === 'pexels' || photographer || /images\.pexels\.com/i.test(url)) return 'Pexels 实拍图'
  if (/waifu\.im/i.test(url)) return '动漫图库'
  return '生图系统'
}

function validImageUrl(value: string | undefined): value is string {
  return !!value && (/^https?:\/\//i.test(value) || value.startsWith('data:image/'))
}

/** Image collection shown as part of the library, rather than a standalone page. */
export function AlbumLibraryView() {
  const hiddenUrls = useSettingsStore((state) => state.hiddenAlbumUrls ?? [])
  const savedImages = useSettingsStore((state) => state.albumSavedImages ?? [])
  const setSettings = useSettingsStore((state) => state.setSettings)
  const contacts = useLiveQuery(() => db.contacts.toArray(), []) ?? EMPTY_LIST
  const moments = useLiveQuery(() => db.moments.toArray(), []) ?? EMPTY_LIST
  const messages = useLiveQuery(() => db.messages.toArray(), []) ?? EMPTY_LIST
  const mediaAssets = useLiveQuery(() => db.mediaAssets.where('status').equals('completed').toArray(), []) ?? EMPTY_LIST
  const [selected, setSelected] = useState<AlbumImage | null>(null)

  const images = (() => {
    const byUrl = new Map<string, AlbumImage>()
    const add = (image: AlbumImage) => {
      if (hiddenUrls.includes(image.url)) return
      const existing = byUrl.get(image.url)
      if (!existing || image.createdAt > existing.createdAt) byUrl.set(image.url, image)
    }
    for (const image of savedImages) add(image)
    for (const contact of contacts) {
      if (validImageUrl(contact.avatar)) add({ url: contact.avatar, createdAt: contact.createdAt, source: sourceFor(contact.avatar, undefined, contact.avatarPhotographer), caption: contact.name })
    }
    for (const moment of moments) {
      if (validImageUrl(moment.imageUrl)) add({ url: moment.imageUrl, createdAt: moment.createdAt, source: sourceFor(moment.imageUrl, undefined, moment.imagePhotographer), caption: moment.content })
    }
    for (const message of messages) {
      if (validImageUrl(message.image?.url)) add({ url: message.image.url, createdAt: message.createdAt, source: sourceFor(message.image.url, message.image.provider, message.image.photographer), caption: message.image.caption ?? message.image.query })
    }
    for (const asset of mediaAssets) {
      const url = asset.dataUrl || asset.remoteUrl
      if (validImageUrl(url)) add({ url, createdAt: asset.completedAt ?? asset.createdAt, source: '生图系统', caption: asset.scene })
    }
    return [...byUrl.values()].sort((a, b) => b.createdAt - a.createdAt)
  })()

  function removeImage(url: string) {
    if (!window.confirm('从相册中删除这张图片？原聊天和朋友圈不会受影响。')) return
    setSettings({ hiddenAlbumUrls: [...new Set([...hiddenUrls, url])] })
    setSelected(null)
  }

  async function downloadImage(image: AlbumImage) {
    try {
      const response = await fetch(image.url)
      if (!response.ok) throw new Error('download failed')
      const blobUrl = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.href = blobUrl
      link.download = `Talk-${image.source}-${new Date(image.createdAt).toISOString().slice(0, 10)}.jpg`
      link.click()
      URL.revokeObjectURL(blobUrl)
    } catch {
      window.open(image.url, '_blank', 'noopener,noreferrer')
    }
  }

  return (
    <>
        <p className="mb-3 px-1 text-xs text-gray-400">已收集聊天、朋友圈和联系人中使用过的动漫图、实拍图与生图。</p>
        {images.length === 0 ? (
          <div className="flex min-h-64 items-center justify-center text-sm text-gray-400">还没有可收集的图片</div>
        ) : (
          <div className="grid grid-cols-3 gap-1.5">
            {images.map((image) => <button key={image.url} type="button" onClick={() => setSelected(image)} className="aspect-square overflow-hidden rounded-lg bg-gray-200"><img src={image.url} alt={image.caption ?? image.source} className="h-full w-full object-cover" loading="lazy" /></button>)}
          </div>
        )}
      {selected && (
        <div className="fixed inset-0 z-[100] flex flex-col bg-black">
          <div role="button" tabIndex={0} onClick={() => setSelected(null)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setSelected(null) }} className="flex min-h-16 cursor-pointer items-center justify-between px-3 pb-3 pt-[calc(env(safe-area-inset-top)+12px)] text-white"><button type="button" aria-label="关闭预览" onClick={() => setSelected(null)} className="flex h-14 w-14 items-center justify-center rounded-full bg-white/15 active:bg-white/25"><X size={28} /></button><span className="text-xs opacity-80">{selected.source}</span><span className="w-14" /></div>
          <div className="flex min-h-0 flex-1 items-center justify-center"><img src={selected.url} alt={selected.caption ?? selected.source} className="max-h-full max-w-full object-contain" /></div>
          <div className="safe-area-bottom flex gap-3 p-4"><button type="button" onClick={() => void downloadImage(selected)} className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-white py-3 text-sm text-gray-900"><Download size={18} />保存图片</button><button type="button" onClick={() => removeImage(selected.url)} className="flex items-center justify-center gap-2 rounded-xl bg-red-500 px-4 py-3 text-sm text-white"><Trash2 size={18} />删除</button></div>
        </div>
      )}
    </>
  )
}
