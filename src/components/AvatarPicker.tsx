import { useRef, useState } from 'react'
import { AVATAR_EMOJIS } from '../lib/avatarEmojis'
import { ImageCropper } from './ImageCropper'
import { Avatar } from './Avatar'

interface AvatarPickerProps {
  onSelect: (avatar: string) => void
  onClose: () => void
}

export function AvatarPicker({ onSelect, onClose }: AvatarPickerProps) {
  const [pendingImage, setPendingImage] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setPendingImage(reader.result as string)
    reader.readAsDataURL(file)
  }

  if (pendingImage) {
    return (
      <ImageCropper
        src={pendingImage}
        onCancel={() => setPendingImage(null)}
        onConfirm={(dataUrl) => {
          onSelect(dataUrl)
          onClose()
        }}
      />
    )
  }

  return (
    <div className="absolute inset-0 z-30 flex items-end bg-black/30" onClick={onClose}>
      <div
        className="w-full rounded-t-2xl bg-white p-4 pb-[calc(env(safe-area-inset-bottom)+16px)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[15px] font-medium text-gray-900">选择头像</h2>
          <button onClick={onClose} className="text-sm text-gray-400">
            取消
          </button>
        </div>

        <button
          onClick={() => fileInput.current?.click()}
          className="mb-3 flex w-full items-center gap-3 rounded-xl bg-gray-50 px-3 py-2.5 text-left active:bg-gray-100"
        >
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#aa3bff]/10 text-lg">
            🖼️
          </div>
          <span className="text-sm text-gray-800">从相册导入图片</span>
        </button>
        <input ref={fileInput} type="file" accept="image/*" onChange={handleFile} className="hidden" />

        <div className="grid grid-cols-6 gap-2">
          {AVATAR_EMOJIS.map((e) => (
            <button
              key={e}
              onClick={() => {
                onSelect(e)
                onClose()
              }}
              className="flex items-center justify-center rounded-xl bg-gray-50 py-2 active:bg-gray-100"
            >
              <Avatar avatar={e} size={36} />
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
