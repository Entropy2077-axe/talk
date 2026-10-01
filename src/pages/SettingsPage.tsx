import { TopBar } from '../components/TopBar'
import { SettingsMenu } from '../components/SettingsMenu'
export function SettingsPage() {
  return <div className="ui-page"><TopBar title="设置" showBack /><div className="ui-page-scroll pb-5"><SettingsMenu /></div></div>
}
