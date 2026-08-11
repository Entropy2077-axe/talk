import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/TopBar'
import { Avatar } from '../components/Avatar'
import { AvatarPicker } from '../components/AvatarPicker'
import { useSettingsStore } from '../store/useSettingsStore'
import { regenerateUserVisualIdentity } from '../lib/imageAssets'

const GENDER_OPTIONS = ['男', '女', '不透露']

export function ProfileEditPage() {
  const navigate = useNavigate()
  const settings = useSettingsStore()

  const [avatar, setAvatar] = useState(settings.userAvatar)
  const [nickname, setNickname] = useState(settings.userNickname)
  const [gender, setGender] = useState(settings.userGender)
  const [birthday, setBirthday] = useState(settings.userBirthday)
  const [bio, setBio] = useState(settings.userBio)
  const [visualIdentity, setVisualIdentity] = useState(settings.userVisualIdentity ?? '')
  const [visualBusy, setVisualBusy] = useState(false)
  const [pickingAvatar, setPickingAvatar] = useState(false)
  const desktop = Boolean(window.talkDesktop)

  function handleSave() {
    settings.setSettings({
      userAvatar: avatar,
      userNickname: nickname.trim() || '我',
      userGender: gender,
      userBirthday: birthday,
      userBio: bio.trim(),
      userVisualIdentity: visualIdentity.trim(),
    })
    void navigate(-1)
  }

  if (desktop) {
    return (
      <div className="desktop-profile-page">
        <div className="desktop-profile-head">
          <button type="button" onClick={() => navigate(-1)} aria-label="返回">‹</button>
          <h1>编辑个人信息</h1>
          <span>信息仅保存在本机</span>
        </div>
        <div className="desktop-profile-scroll">
          <section className="desktop-profile-card">
            <div className="desktop-profile-hero">
              <button type="button" className="desktop-profile-avatar" onClick={() => setPickingAvatar(true)}>
                <Avatar avatar={avatar} size={84} />
              </button>
              <span>点击头像上传本地图片</span>
            </div>
            <div className="desktop-profile-form">
              <label><span>昵称</span><input value={nickname} onChange={(event) => setNickname(event.target.value)} maxLength={20} /></label>
              <label><span>性别</span><div className="desktop-profile-options">{GENDER_OPTIONS.map((value) => <button type="button" key={value} onClick={() => setGender(gender === value ? '' : value)} className={gender === value ? 'active' : ''}>{value}</button>)}</div></label>
              <label><span>生日</span><input type="date" value={birthday} onChange={(event) => setBirthday(event.target.value)} /></label>
              <label><span>个人简介</span><textarea value={bio} onChange={(event) => setBio(event.target.value)} rows={4} placeholder="职业、爱好、性格之类的，会作为聊天背景信息" /></label>
              <label><span>标准长相</span><textarea value={visualIdentity} onChange={(event) => setVisualIdentity(event.target.value)} rows={4} placeholder="稳定外貌，不写衣服、动作、背景或画风"/><button type="button" disabled={visualBusy || !settings.apiKey} onClick={async()=>{if(visualIdentity&& !window.confirm('重新生成会覆盖当前标准长相，确定继续？'))return;setVisualBusy(true);try{setVisualIdentity(await regenerateUserVisualIdentity({...settings,userVisualIdentity:visualIdentity}))}finally{setVisualBusy(false)}}}>{visualBusy?'生成中…':'AI重新生成外貌描述'}</button></label>
              <label><span>数据说明</span><small>头像和资料只写入当前设备，不会上传到 Talk 服务器。</small></label>
            </div>
            <div className="desktop-profile-actions"><button type="button" onClick={() => navigate(-1)}>取消</button><button type="button" className="primary" onClick={handleSave}>保存更改</button></div>
          </section>
        </div>
        {pickingAvatar && <AvatarPicker onSelect={setAvatar} onClose={() => setPickingAvatar(false)} />}
      </div>
    )
  }

  return (
    <div className="ui-page relative">
      <TopBar title="编辑资料" showBack />

      <div className="ui-page-scroll">
      <section className="ui-page-intro flex flex-col items-center gap-2">
        <button onClick={() => setPickingAvatar(true)}>
          <Avatar avatar={avatar} size={80} />
        </button>
        <span className="text-xs text-gray-400">点击更换头像</span>
      </section>

      <h2 className="ui-section-label">聊天对象看到的你</h2>
      <section className="ui-section-card">
        <label className="mb-1 block pt-2 text-xs text-gray-400">昵称</label>
        <input
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          maxLength={20}
          className="mb-3 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
        />

        <label className="mb-1 block text-xs text-gray-400">性别</label>
        <div className="mb-3 flex gap-2">
          {GENDER_OPTIONS.map((v) => (
            <button
              key={v}
              onClick={() => setGender(gender === v ? '' : v)}
              className={`rounded-full px-3 py-1.5 text-xs ${
                gender === v ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'
              }`}
            >
              {v}
            </button>
          ))}
        </div>

        <label className="mb-1 block text-xs text-gray-400">生日</label>
        <input
          type="date"
          value={birthday}
          onChange={(e) => setBirthday(e.target.value)}
          className="mb-3 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
        />

        <label className="mb-1 block text-xs text-gray-400">个人简介</label>
        <textarea
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          placeholder="职业、爱好、性格之类的 会作为背景信息告诉聊天对象"
          rows={4}
          className="mb-3 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
        />
        <label className="mb-1 block text-xs text-gray-400">标准长相</label>
        <textarea value={visualIdentity} onChange={(event) => setVisualIdentity(event.target.value)} rows={4} placeholder="稳定外貌，不写衣服、动作、背景或画风" className="mb-2 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
        <button type="button" disabled={visualBusy || !settings.apiKey} onClick={async()=>{if(visualIdentity&& !window.confirm('重新生成会覆盖当前标准长相，确定继续？'))return;setVisualBusy(true);try{setVisualIdentity(await regenerateUserVisualIdentity({...settings,userVisualIdentity:visualIdentity}))}finally{setVisualBusy(false)}}} className="mb-3 w-full rounded-lg bg-gray-100 py-2 text-xs text-gray-600 disabled:opacity-40">{visualBusy?'生成中…':'AI重新生成外貌描述'}</button>
        <p className="mb-2 text-[11px] text-gray-400">
          这些信息会作为背景资料提供给你聊天的对象 帮助TA更好地理解你、给出更贴切的回复
        </p>
      </section>
      </div>

      <div className="border-t border-[var(--ui-border-soft)] bg-[var(--ui-surface)] p-3 pb-[calc(.75rem+env(safe-area-inset-bottom))]">
        <button onClick={handleSave} className="ui-primary-action w-full py-3 text-sm font-medium">
          保存
        </button>
      </div>

      {pickingAvatar && <AvatarPicker onSelect={setAvatar} onClose={() => setPickingAvatar(false)} />}
    </div>
  )
}
