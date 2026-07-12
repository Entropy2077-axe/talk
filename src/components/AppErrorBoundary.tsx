import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
}

/** Keeps an unexpected render failure from taking the entire app to a blank screen. */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the diagnostic in development tools without exposing internals in the UI.
    console.error('[app] render failed', error, info)
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="flex h-full flex-col items-center justify-center gap-4 bg-[#f4f4f6] px-8 text-center">
          <div className="text-4xl" aria-hidden="true">😵</div>
          <div>
            <h1 className="text-base font-semibold text-gray-900">页面出了点问题</h1>
            <p className="mt-2 text-sm text-gray-500">本地聊天数据没有丢失，重新加载即可继续。</p>
          </div>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm text-white"
          >
            重新加载
          </button>
        </main>
      )
    }
    return this.props.children
  }
}
