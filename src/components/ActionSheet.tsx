interface ActionSheetOption {
  label: string
  onSelect: () => void
  danger?: boolean
}

interface ActionSheetProps {
  options: ActionSheetOption[]
  onClose: () => void
}

export function ActionSheet({ options, onClose }: ActionSheetProps) {
  return (
    <div className="absolute inset-0 z-40 flex items-end bg-black/30" onClick={onClose}>
      <div
        className="w-full rounded-t-2xl bg-white pb-[env(safe-area-inset-bottom)]"
        onClick={(e) => e.stopPropagation()}
      >
        {options.map((opt, i) => (
          <button
            key={i}
            onClick={() => {
              opt.onSelect()
              onClose()
            }}
            className={`block w-full border-b border-gray-100 py-3.5 text-center text-[15px] last:border-b-0 ${
              opt.danger ? 'text-red-500' : 'text-gray-900'
            }`}
          >
            {opt.label}
          </button>
        ))}
        <button onClick={onClose} className="mt-2 block w-full py-3.5 text-center text-[15px] text-gray-500">
          取消
        </button>
      </div>
    </div>
  )
}
