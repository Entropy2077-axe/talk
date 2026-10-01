import type { ReactNode } from 'react'

interface ActionSheetOption {
  label: string
  onSelect: () => void
  danger?: boolean
  group?: string
  icon?: ReactNode
}

interface ActionSheetProps {
  options: ActionSheetOption[]
  onClose: () => void
  title?: string
}

export function ActionSheet({ options, onClose, title }: ActionSheetProps) {
  return (
    <div className="absolute inset-0 z-40 flex items-end bg-black/30" onClick={onClose}>
      <div
        className="w-full rounded-t-2xl bg-white pb-[env(safe-area-inset-bottom)]"
        onClick={(e) => e.stopPropagation()}
      >
        {title && <h2 className="border-b border-gray-100 px-4 py-3 text-center text-sm font-medium text-gray-800">{title}</h2>}
        <div className="max-h-[65vh] overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]">
          {options.map((opt, i) => (
            <div key={i}>
            {opt.group && opt.group !== options[i - 1]?.group && <p className="bg-gray-50 px-4 py-2 text-xs text-gray-500">{opt.group}</p>}
            <button
              onClick={() => {
                opt.onSelect()
                onClose()
              }}
              className={`block w-full border-gray-100 py-3.5 text-center text-[15px] ${i < options.length - 1 ? 'border-b' : ''} ${
                opt.danger ? 'text-red-500' : 'text-gray-900'
              }`}
            >
              {opt.icon && <span className="mr-2 inline-flex align-middle">{opt.icon}</span>}{opt.label}
            </button>
            </div>
          ))}
        </div>
        <button onClick={onClose} className="mt-2 block w-full py-3.5 text-center text-[15px] text-gray-500">
          取消
        </button>
      </div>
    </div>
  )
}
