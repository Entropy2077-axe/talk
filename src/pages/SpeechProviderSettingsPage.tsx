import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { TopBar } from '../components/TopBar'
import { friendlyConnectionError } from '../lib/connectionError'
import { isSpeechProviderReady, MIMO_VOICES, SPEECH_PROVIDER_INFO } from '../lib/speechProviders'
import { synthesizeSpeech } from '../lib/speechSynthesis'
import { useSettingsStore } from '../store/useSettingsStore'
import type { SpeechProviderId, SpeechProvidersSettings } from '../types'

const inputClass = 'w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-gray-400'

export function SpeechProviderSettingsPage() {
  const navigate = useNavigate()
  const { providerId } = useParams()
  const provider = providerId === 'doubao' || providerId === 'mimo' ? providerId : null
  const activeProvider = useSettingsStore((state) => state.speechProvider)
  const providers = useSettingsStore((state) => state.speechProviders)
  const setSettings = useSettingsStore((state) => state.setSettings)
  const [visible, setVisible] = useState(false)
  const [testing, setTesting] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const previewRef = useRef<HTMLAudioElement | null>(null)
  const previewUrlRef = useRef('')

  useEffect(() => () => {
    previewRef.current?.pause()
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
  }, [])

  if (!provider) {
    return <div className="ui-page"><TopBar title="语音服务" showBack /><div className="ui-page-scroll"><div className="ui-empty-state"><p>不支持这个语音服务</p></div></div></div>
  }

  const info = SPEECH_PROVIDER_INFO.find((item) => item.id === provider)!
  const configured = isSpeechProviderReady({ speechProvider: provider, speechProviders: providers })
  const active = activeProvider === provider

  function updateProvider<K extends keyof SpeechProvidersSettings>(id: K, patch: Partial<SpeechProvidersSettings[K]>) {
    const current = useSettingsStore.getState().speechProviders
    setSettings({ speechProviders: { ...current, [id]: { ...current[id], ...patch } } })
    setStatus(null)
  }

  function activate() {
    if (!configured) {
      setStatus({ ok: false, text: '请先补全必填配置，再启用这个服务。' })
      return
    }
    setSettings({ speechProvider: provider as Exclude<SpeechProviderId, 'none'> })
    setStatus({ ok: true, text: `${info.name} 已启用。` })
  }

  async function testConnection() {
    const candidate = { speechProvider: provider as Exclude<SpeechProviderId, 'none'>, speechProviders: useSettingsStore.getState().speechProviders }
    if (!isSpeechProviderReady(candidate)) {
      setStatus({ ok: false, text: '请先补全必填配置。' })
      return
    }
    setTesting(true)
    setStatus(null)
    try {
      const result = await synthesizeSpeech('你好，语音连接成功。', candidate)
      previewRef.current?.pause()
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = URL.createObjectURL(result.blob)
      const audio = new Audio(previewUrlRef.current)
      previewRef.current = audio
      await audio.play()
      setSettings({ speechProvider: provider as Exclude<SpeechProviderId, 'none'> })
      setStatus({ ok: true, text: `真实合成成功，已启用 ${info.name} 并播放试听。` })
    } catch (error) {
      setStatus({ ok: false, text: friendlyConnectionError(error, info.name) })
    } finally {
      setTesting(false)
    }
  }

  const doubao = providers.doubao
  const mimo = providers.mimo

  return (
    <div className="ui-page">
      <TopBar title={info.name} showBack />
      <div className="ui-page-scroll">
        <header className="ui-page-intro"><p className="ui-page-kicker">语音服务</p><h1 className="ui-page-title">{info.name}</h1><p className="ui-page-summary">先确认当前服务与启用状态，再配置鉴权、声音和连接参数。</p></header>
        <section className="ui-section-card px-4 py-4">
          <div className="flex items-center justify-between gap-3"><div><p className="text-sm text-gray-900">服务状态</p><p className={`mt-1 text-xs ${active && configured ? 'text-green-600' : 'text-gray-400'}`}>{active ? configured ? '使用中' : '使用中，但配置不完整' : configured ? '配置已保存，尚未启用' : '尚未完成配置'}</p></div><button type="button" onClick={activate} disabled={active && configured} className="rounded-lg bg-gray-900 px-4 py-2 text-xs text-white disabled:opacity-40">{active ? '已启用' : '启用'}</button></div>
        </section>

        {provider === 'doubao' ? (
          <>
            <section className="ui-section-card ui-section-spaced px-4 py-4">
              <h2 className="mb-3 text-xs font-medium text-gray-400">鉴权与接口</h2>
              <label className="mb-1 block text-xs text-gray-500">控制台类型</label>
              <select value={doubao.authMode} onChange={(e) => updateProvider('doubao', { authMode: e.target.value as 'apiKey' | 'accessKey' })} className={`${inputClass} mb-3`}><option value="apiKey">新版控制台 · API Key</option><option value="accessKey">旧版控制台 · App ID + Access Key</option></select>
              {doubao.authMode === 'apiKey' ? <><label className="mb-1 block text-xs text-gray-500">API Key</label><div className="relative mb-3"><input value={doubao.apiKey} onChange={(e) => updateProvider('doubao', { apiKey: e.target.value })} type={visible ? 'text' : 'password'} placeholder="豆包语音 API Key" className={`${inputClass} pr-16`} /><button type="button" onClick={() => setVisible((value) => !value)} className="absolute inset-y-0 right-0 px-3 text-xs text-gray-500">{visible ? '隐藏' : '显示'}</button></div></> : <><label className="mb-1 block text-xs text-gray-500">App ID</label><input value={doubao.appId} onChange={(e) => updateProvider('doubao', { appId: e.target.value })} className={`${inputClass} mb-3`} /><label className="mb-1 block text-xs text-gray-500">Access Key / Token</label><div className="relative mb-3"><input value={doubao.accessKey} onChange={(e) => updateProvider('doubao', { accessKey: e.target.value })} type={visible ? 'text' : 'password'} className={`${inputClass} pr-16`} /><button type="button" onClick={() => setVisible((value) => !value)} className="absolute inset-y-0 right-0 px-3 text-xs text-gray-500">{visible ? '隐藏' : '显示'}</button></div></>}
              <label className="mb-1 block text-xs text-gray-500">接口地址</label><input value={doubao.baseUrl} onChange={(e) => updateProvider('doubao', { baseUrl: e.target.value })} className={`${inputClass} mb-3`} />
              <label className="mb-1 block text-xs text-gray-500">Resource ID</label><input value={doubao.resourceId} onChange={(e) => updateProvider('doubao', { resourceId: e.target.value })} placeholder="seed-tts-2.0" className={inputClass} />
            </section>
            <section className="ui-section-card ui-section-spaced px-4 py-4">
              <h2 className="mb-1 text-xs font-medium text-gray-400">合成参数与连接测试</h2>
              <p className="mb-3 text-[11px] leading-relaxed text-gray-400">这里的音色只用于连接测试，也会作为可选音色加入联系人名片；实际聊天必须为每位联系人单独选择。</p>
              <label className="mb-1 block text-xs text-gray-500">测试音色 ID / Speaker</label><input value={doubao.speaker} onChange={(e) => updateProvider('doubao', { speaker: e.target.value })} list="doubao-speakers" className={`${inputClass} mb-3`} /><datalist id="doubao-speakers"><option value="zh_female_vv_uranus_bigtts">Vivi 2.0</option><option value="zh_female_xiaohe_uranus_bigtts">小何</option><option value="zh_male_dayi_saturn_bigtts">大壹</option></datalist>
              <div className="grid grid-cols-2 gap-3"><label className="text-xs text-gray-500">语速（0.5～2）<input type="number" min="0.5" max="2" step="0.1" value={doubao.speedRatio} onChange={(e) => updateProvider('doubao', { speedRatio: Number(e.target.value) })} className={`${inputClass} mt-1`} /></label><label className="text-xs text-gray-500">音量（0.5～2）<input type="number" min="0.5" max="2" step="0.1" value={doubao.loudnessRatio} onChange={(e) => updateProvider('doubao', { loudnessRatio: Number(e.target.value) })} className={`${inputClass} mt-1`} /></label></div>
              <div className="mt-3 grid grid-cols-2 gap-3"><label className="text-xs text-gray-500">格式<select value={doubao.format} onChange={(e) => updateProvider('doubao', { format: e.target.value as 'mp3' | 'ogg_opus' })} className={`${inputClass} mt-1`}><option value="mp3">MP3</option><option value="ogg_opus">OGG Opus</option></select></label><label className="text-xs text-gray-500">采样率<select value={doubao.sampleRate} onChange={(e) => updateProvider('doubao', { sampleRate: Number(e.target.value) as 8000 | 16000 | 24000 })} className={`${inputClass} mt-1`}><option value="24000">24000 Hz</option><option value="16000">16000 Hz</option><option value="8000">8000 Hz</option></select></label></div>
              <label className="mt-3 mb-1 block text-xs text-gray-500">情感（留空为自动，仅部分音色支持）</label><input value={doubao.emotion} onChange={(e) => updateProvider('doubao', { emotion: e.target.value })} placeholder="例如 happy、sad、angry" className={`${inputClass} mb-3`} />
              {doubao.emotion.trim() && <label className="text-xs text-gray-500">情感强度（1～5）<input type="number" min="1" max="5" step="1" value={doubao.emotionScale} onChange={(e) => updateProvider('doubao', { emotionScale: Number(e.target.value) })} className={`${inputClass} mt-1`} /></label>}
              <p className="mt-3 text-[11px] leading-relaxed text-gray-400">Resource ID 必须与音色系列匹配；例如 Seed-TTS 2.0 通常使用带 uranus 标识的音色。完整音色 ID 请以你的豆包语音控制台为准。</p>
            </section>
          </>
        ) : (
          <>
            <section className="ui-section-card ui-section-spaced px-4 py-4">
              <h2 className="mb-3 text-xs font-medium text-gray-400">鉴权与接口</h2>
              <label className="mb-1 block text-xs text-gray-500">API Key</label><div className="relative mb-3"><input value={mimo.apiKey} onChange={(e) => updateProvider('mimo', { apiKey: e.target.value })} type={visible ? 'text' : 'password'} placeholder="MiMo API Key" className={`${inputClass} pr-16`} /><button type="button" onClick={() => setVisible((value) => !value)} className="absolute inset-y-0 right-0 px-3 text-xs text-gray-500">{visible ? '隐藏' : '显示'}</button></div>
              <label className="mb-1 block text-xs text-gray-500">Base URL</label><input value={mimo.baseUrl} onChange={(e) => updateProvider('mimo', { baseUrl: e.target.value })} className={`${inputClass} mb-3`} />
              <label className="mb-1 block text-xs text-gray-500">模型</label><input value={mimo.model} readOnly className={`${inputClass} bg-gray-50 text-gray-500`} />
            </section>
            <section className="ui-section-card ui-section-spaced px-4 py-4">
              <h2 className="mb-1 text-xs font-medium text-gray-400">合成参数与连接测试</h2>
              <p className="mb-3 text-[11px] leading-relaxed text-gray-400">测试音色不会统一套给联系人。新联系人会由人物生成 AI 自动匹配，已有联系人可在各自名片里修改。</p>
              <label className="mb-1 block text-xs text-gray-500">测试音色</label><select value={mimo.voice} onChange={(e) => updateProvider('mimo', { voice: e.target.value })} className={`${inputClass} mb-3`}>{MIMO_VOICES.map((voice) => <option key={voice.id} value={voice.id}>{voice.name}</option>)}</select>
              <label className="mb-1 block text-xs text-gray-500">默认演绎指导（联系人未单独填写时使用）</label><textarea value={mimo.styleInstruction} onChange={(e) => updateProvider('mimo', { styleInstruction: e.target.value })} rows={4} placeholder="例如：温柔、自然，语速稍慢，像在安慰熟悉的人。" className={`${inputClass} resize-y`} />
              <div className="mt-3 grid grid-cols-2 gap-3"><label className="text-xs text-gray-500">格式<select value={mimo.format} onChange={(e) => updateProvider('mimo', { format: e.target.value as 'mp3' | 'wav' })} className={`${inputClass} mt-1`}><option value="mp3">MP3</option><option value="wav">WAV</option></select></label><label className="text-xs text-gray-500">温度（0～1.5）<input type="number" min="0" max="1.5" step="0.1" value={mimo.temperature} onChange={(e) => updateProvider('mimo', { temperature: Number(e.target.value) })} className={`${inputClass} mt-1`} /></label></div>
              <p className="mt-3 text-[11px] leading-relaxed text-gray-400">演绎指导不会被读出来，只用于控制语速、情绪、方言和说话风格。第一版使用预置音色，不上传声音复刻样本。</p>
            </section>
          </>
        )}

        <section className="ui-section-card ui-section-spaced px-4 py-4">
          <button type="button" onClick={() => void testConnection()} disabled={testing} className="w-full rounded-lg bg-gray-900 py-2.5 text-sm text-white disabled:opacity-50">{testing ? '正在生成试听…' : '测试连接并试听'}</button>
          <p className="mt-2 text-[11px] text-gray-400">测试文本：“你好，语音连接成功。”真实生成成功后会自动播放。</p>
          {status && <p className={`mt-2 text-xs ${status.ok ? 'text-green-600' : 'text-red-500'}`}>{status.text}</p>}
        </section>
        <button type="button" onClick={() => navigate('/settings/speech-generation')} className="mx-4 mt-4 w-[calc(100%-2rem)] rounded-lg bg-white py-2.5 text-sm text-gray-600">返回语音服务列表</button>
      </div>
    </div>
  )
}
