import { useMemo, useState } from 'react'

interface ModelPickerProps {
  title: string
  models: string[]
  value: string
  onSelect: (model: string) => void
  onClose: () => void
}

export function ModelPicker({ title, models, value, onSelect, onClose }: ModelPickerProps) {
  const [query, setQuery] = useState('')
  const filteredModels = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return models
    return models.filter((model) => model.toLowerCase().includes(normalized))
  }, [models, query])

  return (
    <div className="absolute inset-0 z-50 flex flex-col bg-[#f4f4f6]" role="dialog" aria-modal="true" aria-label={title}>
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-gray-200 bg-white px-4">
        <button type="button" onClick={onClose} className="text-sm text-gray-500">取消</button>
        <h2 className="text-[15px] font-medium text-gray-900">{title}</h2>
        <span className="w-7" aria-hidden="true" />
      </div>

      <div className="bg-white px-4 py-3">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索模型名称"
          aria-label="搜索模型名称"
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-gray-400"
        />
        <p className="mt-1.5 text-[11px] text-gray-400">
          共 {models.length} 个模型{query.trim() ? `，找到 ${filteredModels.length} 个` : ''}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-white [-webkit-overflow-scrolling:touch]">
        {filteredModels.map((model) => (
          <button
            key={model}
            type="button"
            onClick={() => {
              onSelect(model)
              onClose()
            }}
            className="flex w-full items-center gap-3 border-b border-gray-100 px-4 py-3 text-left active:bg-gray-50"
          >
            <span className="min-w-0 flex-1 break-all text-sm text-gray-800">{model}</span>
            {model === value && <span className="shrink-0 text-sm text-green-600" aria-label="当前模型">✓</span>}
          </button>
        ))}
        {filteredModels.length === 0 && (
          <p className="px-4 py-10 text-center text-sm text-gray-400">没有匹配的模型</p>
        )}
      </div>
    </div>
  )
}
