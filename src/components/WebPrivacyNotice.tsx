import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSettingsStore } from '../store/useSettingsStore'

const DISMISSED_KEY = 'talk-web-privacy-notice-dismissed'
const isHostedDemo = import.meta.env.VITE_DEPLOY_TARGET === 'github-pages'

export function WebPrivacyNotice() {
  const navigate = useNavigate()
  const apiKey = useSettingsStore((s) => s.apiKey)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (isHostedDemo && !apiKey && localStorage.getItem(DISMISSED_KEY) !== '1') setVisible(true)
  }, [apiKey])

  if (!visible) return null

  const dismiss = () => {
    localStorage.setItem(DISMISSED_KEY, '1')
    setVisible(false)
  }

  return (
    <div className="absolute inset-0 z-[100] flex items-end bg-black/35 p-4 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="web-privacy-title">
      <div className="mx-auto w-full max-w-sm rounded-2xl bg-white p-5 text-gray-900 shadow-xl">
        <h2 id="web-privacy-title" className="text-lg font-semibold">开始体验 Talk</h2>
        <p className="mt-2 text-sm leading-6 text-gray-600">
          Talk 不提供公共 AI 代理，也不会内置 API Key。请使用你自己的 DeepSeek Key；Key、联系人和聊天数据只保存在当前浏览器本地。
        </p>
        <p className="mt-2 text-xs leading-5 text-gray-500">清理浏览器数据会删除本地内容，重要数据请先在设置中导出备份。</p>
        <button
          type="button"
          onClick={() => { dismiss(); navigate('/settings') }}
          className="mt-4 w-full rounded-xl bg-green-600 px-4 py-3 text-sm font-medium text-white"
        >
          前往设置 API Key
        </button>
        <button type="button" onClick={dismiss} className="mt-2 w-full px-4 py-2 text-sm text-gray-500">先看看界面</button>
      </div>
    </div>
  )
}
