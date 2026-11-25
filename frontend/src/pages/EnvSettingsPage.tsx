import { useEffect, useState } from 'react'
import { api, json } from '../lib'

type SecretStatus = { configured: boolean; source: 'dotenv' | 'environment' | 'missing' }
type ModelStatus = { value: string; source: 'dotenv' | 'environment' | 'default' }
type EnvStatus = { hf_token: SecretStatus; openai_api_key: SecretStatus; openai_model: ModelStatus; openrouter_api_key?: SecretStatus; openrouter_model?: ModelStatus; ollama_model?: ModelStatus; cambridge_api_key?: SecretStatus; cambridge_dictionary_code?: ModelStatus }
type Key = 'HF_TOKEN' | 'OPENAI_API_KEY' | 'OPENAI_MODEL' | 'OPENROUTER_API_KEY' | 'OPENROUTER_MODEL' | 'OLLAMA_MODEL' | 'CAMBRIDGE_API_KEY' | 'CAMBRIDGE_DICTIONARY_CODE'

function sourceLabel(source: string) {
  return source === 'dotenv' ? 'Сохранено в .env' : source === 'environment' ? 'Задано в системе' : source === 'default' ? 'Значение по умолчанию' : 'Не задано'
}

export function EnvSettingsPage() {
  const [settings, setSettings] = useState<EnvStatus | null>(null)
  const [hfToken, setHfToken] = useState('')
  const [routerKey, setRouterKey] = useState('')
  const [routerModel, setRouterModel] = useState('')
  const [ollamaModel, setOllamaModel] = useState('')
  const [cambridgeKey, setCambridgeKey] = useState('')
  const [cambridgeCode, setCambridgeCode] = useState('')
  const [busy, setBusy] = useState<Key | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    api<EnvStatus>('/settings/env').then(value => {if (!cancelled) {setSettings(value); setRouterModel(value.openrouter_model?.value || 'openai/gpt-4o-mini'); setOllamaModel(value.ollama_model?.value || 'qwen2.5:7b'); setCambridgeCode(value.cambridge_dictionary_code?.value || 'english-russian')}}).catch(reason => {if (!cancelled) setError((reason as Error).message)})
    return () => {cancelled = true}
  }, [])

  async function change(key: Key, value: string | null) {
    setBusy(key); setError(''); setMessage('')
    try {
      const next = await api<EnvStatus>('/settings/env', json('PATCH', {key, value}))
      setSettings(next)
      if (key === 'HF_TOKEN') setHfToken('')
      if (key === 'OPENROUTER_API_KEY') setRouterKey('')
      if (key === 'OPENROUTER_MODEL') setRouterModel(next.openrouter_model?.value || '')
      if (key === 'OLLAMA_MODEL') setOllamaModel(next.ollama_model?.value || '')
      if (key === 'CAMBRIDGE_API_KEY') setCambridgeKey('')
      if (key === 'CAMBRIDGE_DICTIONARY_CODE') setCambridgeCode(next.cambridge_dictionary_code?.value || '')
      setMessage(value === null ? 'Настройка удалена из .env' : 'Настройка сохранена в .env')
    } catch (reason) {setError((reason as Error).message)}
    finally {setBusy(null)}
  }
  function remove(key: Key) {
    if (window.confirm(`Удалить ${key} из .env?`)) void change(key, null)
  }

  return <><header><div><p className="eyebrow">СТУДИЯ LUMIR DUB</p><h1>Настройки .env</h1></div></header><section className="env-page"><div className="detail-head"><p className="eyebrow">ПОДКЛЮЧЕНИЯ</p><h2>API-ключи и модель</h2><p>Настройки сохраняются в корневом файле .env и применяются при следующем запуске обработки. Сохранённые ключи здесь не показываются.</p></div>
    {error && <p className="env-alert error" role="alert">{error}</p>}{message && <p className="env-alert" role="status">{message}</p>}
    {!settings ? <p>Загружаем настройки…</p> : <div className="env-grid">
      <section className="env-card"><div className="env-card-head"><div><h3>Hugging Face</h3><code>HF_TOKEN</code></div><span className={settings.hf_token.configured ? 'env-state ready' : 'env-state'}>{settings.hf_token.configured ? '● Подключено' : '○ Не задано'}</span></div><p>Нужен для модели определения говорящих pyannote.</p><small>{sourceLabel(settings.hf_token.source)}</small><label>Новый токен<input type="password" autoComplete="new-password" value={hfToken} onChange={event => setHfToken(event.target.value)} placeholder="Вставьте токен Hugging Face"/></label><div className="env-actions"><button disabled={busy !== null || !hfToken.trim()} onClick={() => void change('HF_TOKEN', hfToken)}>Сохранить токен</button><button className="outline" disabled={busy !== null || settings.hf_token.source !== 'dotenv'} onClick={() => remove('HF_TOKEN')}>Удалить из .env</button></div></section>
      {settings.ollama_model && <section className="env-card"><h3>Локальная Ollama</h3><code>OLLAMA_MODEL</code><p>Модель для локального перевода. Сначала загрузите её в Ollama.</p><label>Модель Ollama<input value={ollamaModel} onChange={event => setOllamaModel(event.target.value)}/></label><div className="env-actions"><button disabled={busy !== null || !ollamaModel.trim()} onClick={() => void change('OLLAMA_MODEL', ollamaModel.trim())}>Сохранить</button></div></section>}
      {settings.openrouter_api_key && <section className="env-card"><h3>OpenRouter</h3><code>OPENROUTER_API_KEY</code><p>Запасной способ перевода через API.</p><small>{sourceLabel(settings.openrouter_api_key.source)}</small><label>Ключ OpenRouter<input type="password" autoComplete="new-password" value={routerKey} onChange={event => setRouterKey(event.target.value)}/></label><div className="env-actions"><button disabled={busy !== null || !routerKey.trim()} onClick={() => void change('OPENROUTER_API_KEY', routerKey)}>Сохранить ключ</button><button className="outline" disabled={busy !== null || settings.openrouter_api_key.source !== 'dotenv'} onClick={() => remove('OPENROUTER_API_KEY')}>Удалить</button></div><label>Модель OpenRouter<input value={routerModel} onChange={event => setRouterModel(event.target.value)}/></label><div className="env-actions"><button disabled={busy !== null || !routerModel.trim()} onClick={() => void change('OPENROUTER_MODEL', routerModel.trim())}>Сохранить модель</button></div></section>}
      {settings.cambridge_api_key && <section className="env-card"><h3>Cambridge Dictionary</h3><code>CAMBRIDGE_API_KEY</code><p>Для показа до трёх словарных переводов на экране перевода. Нужен отдельный ключ Cambridge Dictionary API.</p><small>{sourceLabel(settings.cambridge_api_key.source)}</small><label>Ключ Cambridge API<input type="password" autoComplete="new-password" value={cambridgeKey} onChange={event => setCambridgeKey(event.target.value)}/></label><div className="env-actions"><button disabled={busy !== null || !cambridgeKey.trim()} onClick={() => void change('CAMBRIDGE_API_KEY', cambridgeKey)}>Сохранить ключ</button><button className="outline" disabled={busy !== null || settings.cambridge_api_key.source !== 'dotenv'} onClick={() => remove('CAMBRIDGE_API_KEY')}>Удалить</button></div><label>Код словаря<input value={cambridgeCode} onChange={event => setCambridgeCode(event.target.value)}/></label><div className="env-actions"><button disabled={busy !== null || !cambridgeCode.trim()} onClick={() => void change('CAMBRIDGE_DICTIONARY_CODE', cambridgeCode.trim())}>Сохранить код</button></div><a href="https://dictionary.cambridge.org/develop.html" target="_blank" rel="noreferrer">Как получить доступ к Cambridge API ↗</a></section>}
    </div>}
  </section></>
}
