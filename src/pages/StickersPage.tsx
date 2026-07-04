import { useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { ActionSheet } from '../components/ActionSheet'
import { resizeImageDataUrl } from '../lib/image'
import type { Sticker } from '../types'

export function StickersPage() {
  const stickers = useLiveQuery(() => db.stickers.orderBy('createdAt').reverse().toArray(), []) ?? []
  const [pendingImage, setPendingImage] = useState<string | null>(null)
  const [nameDraft, setNameDraft] = useState('')
  const [error, setError] = useState('')
  const [renaming, setRenaming] = useState<Sticker | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [renameError, setRenameError] = useState('')
  const [deleting, setDeleting] = useState<Sticker | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = async () => {
      const resized = await resizeImageDataUrl(reader.result as string)
      setPendingImage(resized)
    }
    reader.readAsDataURL(file)
  }

  async function handleSave() {
    const name = nameDraft.trim()
    if (!name || !pendingImage) return
    const exists = await db.stickers.where('name').equals(name).count()
    if (exists > 0) {
      setError('这个名字已经被使用了 换一个吧')
      return
    }
    await db.stickers.add({ id: uuid(), name, dataUrl: pendingImage, createdAt: Date.now() })
    setPendingImage(null)
    setNameDraft('')
    setError('')
    if (fileInput.current) fileInput.current.value = ''
  }

  async function handleRename() {
    if (!renaming) return
    const name = renameDraft.trim()
    if (!name) return
    if (name !== renaming.name) {
      const exists = await db.stickers.where('name').equals(name).count()
      if (exists > 0) {
        setRenameError('这个名字已经被使用了 换一个吧')
        return
      }
    }
    await db.stickers.update(renaming.id, { name })
    setRenaming(null)
    setRenameError('')
  }

  return (
    <div className="relative flex min-h-full flex-col bg-[#f4f4f6]">
      <TopBar title="表情包管理" showBack />

      <section className="mt-3 bg-white px-4 py-4">
        <h2 className="mb-2 text-xs font-medium text-gray-400">添加表情包</h2>
        <input ref={fileInput} type="file" accept="image/*" onChange={handleFile} className="mb-2 text-sm" />
        {pendingImage && (
          <div className="mb-2 flex items-center gap-3">
            <img src={pendingImage} alt="预览" className="h-16 w-16 rounded-lg object-cover" />
            <input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              placeholder="给表情包起个唯一的名字"
              className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm"
            />
          </div>
        )}
        {error && <p className="mb-2 text-xs text-red-500">{error}</p>}
        <button
          onClick={handleSave}
          disabled={!pendingImage || !nameDraft.trim()}
          className="w-full rounded-lg bg-gray-900 py-2 text-sm text-white disabled:opacity-40"
        >
          保存表情包
        </button>
      </section>

      <section className="mt-3 flex-1 bg-white px-4 py-4">
        <h2 className="mb-3 text-xs font-medium text-gray-400">已有表情包（{stickers.length}）</h2>
        {stickers.length === 0 ? (
          <p className="text-sm text-gray-400">还没有表情包 对方暂时无法发送表情</p>
        ) : (
          <div className="grid grid-cols-4 gap-3">
            {stickers.map((s) => (
              <div key={s.id} className="flex flex-col items-center gap-1">
                <img src={s.dataUrl} alt={s.name} className="h-16 w-16 rounded-lg object-cover" />
                <button
                  onClick={() => {
                    setRenaming(s)
                    setRenameDraft(s.name)
                    setRenameError('')
                  }}
                  className="max-w-full truncate text-[11px] text-gray-500 underline decoration-dotted"
                >
                  {s.name}
                </button>
                <button onClick={() => setDeleting(s)} className="text-[11px] text-red-400">
                  删除
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {renaming && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/30 p-8">
          <div className="w-full rounded-2xl bg-white p-4">
            <h2 className="mb-3 text-center text-[15px] font-medium text-gray-900">重命名表情包</h2>
            <input
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              maxLength={20}
              className="mb-2 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
            />
            {renameError && <p className="mb-2 text-xs text-red-500">{renameError}</p>}
            <div className="flex gap-2">
              <button
                onClick={() => setRenaming(null)}
                className="flex-1 rounded-lg bg-gray-100 py-2 text-sm text-gray-600"
              >
                取消
              </button>
              <button
                onClick={handleRename}
                disabled={!renameDraft.trim()}
                className="flex-1 rounded-lg bg-gray-900 py-2 text-sm text-white disabled:opacity-40"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {deleting && (
        <ActionSheet
          onClose={() => setDeleting(null)}
          options={[
            {
              label: `确认删除表情包"${deleting.name}"`,
              onSelect: () => db.stickers.delete(deleting.id),
              danger: true,
            },
          ]}
        />
      )}
    </div>
  )
}
