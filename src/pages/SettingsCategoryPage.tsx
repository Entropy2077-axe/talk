import { TopBar } from '../components/TopBar'
import { SettingsLinks } from '../components/SettingsMenu'

export function AiSettingsPage() {
  return <div className="ui-page"><TopBar title="AI 设置" showBack /><div className="ui-page-scroll pb-5">
    <SettingsLinks entries={[
      { to: '/settings/api-configurations', label: '模型连接', note: 'API Key、模型与备用接口', icon: '🤖' },
      { to: '/presets', label: '提示词预设', note: '调整 AI 的回复方式与生成参数', icon: '✍️' },
      { to: '/settings/other-interfaces', label: '接口服务', note: '图片、语音与联网服务', icon: 'link' },
    ]} />
    <SettingsLinks entries={[{ to: '/settings/ai/advanced', label: '行动判断与调用预算', note: '多功能模型 / Jev、后台自动调用上限', icon: '⚙' }]} />
  </div></div>
}

export function CreationSettingsPage() {
  return <div className="ui-page"><TopBar title="创作与素材" showBack /><div className="ui-page-scroll pb-5">
    <SettingsLinks entries={[
      { to: '/drawing-tool', label: '绘图工具', note: '输入提示词生成图片、配置绘图服务', icon: 'image' },
      { to: '/stickers', label: '表情包管理', note: '管理本地表情与远程表情服务', icon: '☺' },
    ]} />
  </div></div>
}
