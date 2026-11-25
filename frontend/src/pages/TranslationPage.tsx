import { useEffect, useRef, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import type { AILine } from '../lib'
import { api, stamp } from '../lib'
import type { ProjectActions } from '../components/ProjectWorkspace'

type AIProviders = {ollama_running: boolean; ollama_model_installed: boolean; ollama_model: string; openrouter_configured: boolean; openrouter_model: string}
type CambridgeLookup = {configured: boolean; translations: string[]; url: string}

export function TranslationPage() {
  const actions = useOutletContext<ProjectActions>()
  const {project, busy} = actions
  const [context, setContext] = useState(project.context_notes)
  const [language, setLanguage] = useState(project.target_language)
  const [provider, setProvider] = useState<'ollama' | 'openrouter'>(project.ai_provider)
  const [availability, setAvailability] = useState<AIProviders | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [follow, setFollow] = useState(true)
  const video = useRef<HTMLVideoElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const changed = context !== project.context_notes || language.trim() !== project.target_language || provider !== project.ai_provider
  const names = Object.fromEntries(project.speakers.map(speaker => [speaker.id, speaker.name]))

  useEffect(() => {setContext(project.context_notes); setLanguage(project.target_language); setProvider(project.ai_provider)}, [project.context_notes, project.target_language, project.ai_provider])
  useEffect(() => {
    let cancelled = false
    api<AIProviders>('/ai/providers').then(status => {
      if (cancelled) return
      setAvailability(status)
      if (!project.ai_lines.length && !status.ollama_model_installed && status.openrouter_configured && project.ai_provider === 'ollama') setProvider('openrouter')
    }).catch(() => {})
    return () => {cancelled = true}
  }, [project.id])
  useEffect(() => {
    if (!follow || !activeId || !list.current) return
    const row = Array.from(list.current.children).find(child => (child as HTMLElement).dataset.lineId === activeId)
    row?.scrollIntoView({block: 'nearest', behavior: 'smooth'})
  }, [activeId, follow])

  async function run() {
    if (!language.trim()) {actions.onError('Укажите язык перевода'); return}
    if (project.ai_lines.length && !window.confirm('Повторный AI-анализ заменит текущий перевод и ручные правки. Продолжить?')) return
    if (changed && !await actions.saveAIConfig(context, language.trim(), provider)) return
    await actions.runAI()
  }
  function syncVideo() {
    const time = video.current?.currentTime ?? 0
    setActiveId(project.ai_lines.find(line => line.start <= time && line.end >= time)?.id ?? null)
  }
  function seek(line: AILine) {
    if (!video.current) return
    video.current.currentTime = line.start
    void video.current.play().catch(() => {})
    setActiveId(line.id)
    setFollow(true)
  }

  return <section className="translation-page"><div className="detail-head"><p className="eyebrow">AI-ПЕРЕВОД</p><h2>Анализ и перевод</h2><p>AI объединяет соседние фрагменты одного говорящего в предложения и переводит их с учётом контекста. Исходная транскрипция сохраняется отдельно.</p></div>
    <div className="ai-config"><label>Модель<select value={provider} onChange={event => setProvider(event.target.value as 'ollama' | 'openrouter')}><option value="ollama">Ollama · локально</option><option value="openrouter">OpenRouter API</option></select></label><label>Язык перевода<input value={language} onChange={event => setLanguage(event.target.value)} list="translation-languages" maxLength={80}/><datalist id="translation-languages"><option value="Russian"/><option value="Ukrainian"/><option value="English"/></datalist></label><label className="context-field">Контекст сцены, имена и желаемые термины<textarea value={context} onChange={event => setContext(event.target.value)} maxLength={10000} rows={3} placeholder="Например: это фантастический сериал; Lumir — имя героя; сохраняй названия заклинаний…"/></label><div className="ai-buttons"><button className="secondary" disabled={busy || !changed || !language.trim() || project.ai_status === 'processing'} onClick={() => void actions.saveAIConfig(context, language.trim(), provider)}>Сохранить контекст</button><button className="primary" disabled={busy || !language.trim() || project.status !== 'complete' || project.segments.length === 0 || project.ai_status === 'processing'} onClick={() => void run()}>{project.ai_lines.length ? 'Повторить AI-анализ' : 'Анализировать и перевести'}</button></div><small className="ai-privacy">{provider === 'ollama' ? 'Ollama обрабатывает текст локально. Запустите Ollama и загрузите модель.' : 'В OpenRouter отправляются текст транскрипции и контекст. Видео остаётся на компьютере.'}</small>{availability && <p className="ai-provider-status" role="status">{provider === 'ollama' ? availability.ollama_model_installed ? `Ollama готова: ${availability.ollama_model}` : availability.ollama_running ? `Модель ${availability.ollama_model} не загружена. Выполните ollama pull ${availability.ollama_model}.` : 'Ollama не запущена. Выберите OpenRouter или запустите локальную модель.' : availability.openrouter_configured ? `Ключ OpenRouter настроен · ${availability.openrouter_model}` : 'Ключ OpenRouter отсутствует. Добавьте его во вкладке «Настройки .env».'}</p>}</div>
    {project.status !== 'complete' && <p className="ai-note">Сначала завершите транскрипцию видео.</p>}
    {project.ai_status === 'processing' && <div className="ai-note" role="status">AI анализирует реплики и переводит их · {project.ai_progress}%<div className="progress-track" role="progressbar" aria-label="Прогресс AI-перевода" aria-valuenow={project.ai_progress} aria-valuemin={0} aria-valuemax={100}><div style={{width: `${project.ai_progress}%`}}/></div></div>}
    {project.ai_status === 'failed' && <p className="ai-note ai-error" role="alert">{project.ai_error || 'AI-анализ не удался'}</p>}
    {project.ai_status === 'stale' && <p className="ai-note">Исходные реплики изменились после перевода. Запустите AI-анализ снова, чтобы обновить его.</p>}
    {project.ai_lines.length > 0 && <><div className="ai-export"><span>{project.ai_lines.length} строк перевода</span><button onClick={() => void actions.download('english-dialogue-txt')}>Английский диалог ↓</button><button onClick={() => void actions.download('dialogue-txt')}>Русский диалог ↓</button><button onClick={() => void actions.download('translated-srt')}>Скачать SRT ↓</button><button onClick={() => setFollow(true)}>{follow ? '● Слежение включено' : '↘ К текущей реплике'}</button></div><div className="ai-workspace"><div className="ai-video"><video ref={video} controls preload="metadata" src={`/api/projects/${project.id}/video`} onTimeUpdate={syncVideo}/><p>{project.title}</p></div><div className="ai-list" ref={list} onWheel={() => setFollow(false)} onTouchStart={() => setFollow(false)} onKeyDown={event => {if (['ArrowUp','ArrowDown','PageUp','PageDown','Home','End'].includes(event.key)) setFollow(false)}} tabIndex={0} aria-label="Переведённые реплики с прокруткой">{project.ai_lines.map(line => <TranslationRow key={line.id} line={line} speaker={names[line.speaker_id || ''] || 'Неизвестно'} active={activeId === line.id} busy={busy || project.ai_status === 'processing'} onSeek={() => seek(line)} onSave={text => actions.saveAILine(line, text)}/>)}</div></div></>}
  </section>
}

function TranslationRow({line, speaker, active, busy, onSeek, onSave}: {line: AILine; speaker: string; active: boolean; busy: boolean; onSeek: () => void; onSave: (text: string) => Promise<boolean>}) {
  const [text, setText] = useState(line.translated_text)
  const [word, setWord] = useState('')
  const [dictionary, setDictionary] = useState<CambridgeLookup | null>(null)
  const [dictionaryLoading, setDictionaryLoading] = useState(false)
  const linked = line.word_links?.find(item => item.english.toLowerCase().match(/[a-z][a-z'-]*/g)?.includes(word.toLowerCase()))?.russian
  const highlighted = [linked, ...(dictionary?.translations || [])].find(value => value && text.toLocaleLowerCase().includes(value.toLocaleLowerCase()))
  const matchAt = highlighted ? text.toLocaleLowerCase().indexOf(highlighted.toLocaleLowerCase()) : -1
  useEffect(() => {setText(line.translated_text)}, [line.translated_text])
  useEffect(() => {
    if (!word) {setDictionary(null); return}
    const controller = new AbortController()
    setDictionary(null); setDictionaryLoading(true)
    const timer = window.setTimeout(() => {
      api<CambridgeLookup>(`/dictionary/cambridge?word=${encodeURIComponent(word.toLowerCase())}`, {signal: controller.signal})
        .then(value => setDictionary(value))
        .catch(() => {if (!controller.signal.aborted) setDictionary(null)})
        .finally(() => {if (!controller.signal.aborted) setDictionaryLoading(false)})
    }, 300)
    return () => {window.clearTimeout(timer); controller.abort()}
  }, [word, line.id])
  const dictionaryUrl = dictionary?.url || `https://dictionary.cambridge.org/dictionary/english-russian/${encodeURIComponent(word.toLowerCase())}`
  return <article data-line-id={line.id} className={active ? 'ai-line active' : 'ai-line'}>
    <div className="ai-english"><strong>{speaker}</strong><button className="time" onClick={onSeek}>{stamp(line.start)}</button>
      <p className="ai-source">{line.source_text.split(/(\b[A-Za-z][A-Za-z'-]*\b)/g).map((part, index) => /^[A-Za-z][A-Za-z'-]*$/.test(part) ? <button key={index} className={`ai-word${word.toLowerCase() === part.toLowerCase() ? ' selected' : ''}`} aria-pressed={word.toLowerCase() === part.toLowerCase()} onMouseEnter={() => setWord(part)} onFocus={() => setWord(part)} onClick={() => setWord(part)}>{part}</button> : <span key={index}>{part}</span>)}</p>
      {word && <div className="ai-dictionary"><strong>{word}</strong>{linked && <span>В этой реплике: {linked}</span>}{dictionaryLoading && <span>Ищем в Cambridge…</span>}{dictionary?.translations.length ? <><span>Cambridge · варианты перевода</span><ol>{dictionary.translations.map(value => <li key={value}>{value}</li>)}</ol></> : dictionary && !dictionary.configured ? <span>Для трёх значений Cambridge добавьте ключ во вкладке «Настройки .env».</span> : dictionary && <span>В Cambridge перевод не найден.</span>}<a href={dictionaryUrl} target="_blank" rel="noreferrer">Открыть Cambridge Dictionary ↗</a></div>}
    </div>
    <div className={word ? 'ai-russian word-focused' : 'ai-russian'}><strong>Перевод</strong><p className="ai-translation-preview">{word && matchAt >= 0 && highlighted ? <>{text.slice(0, matchAt)}<mark>{text.slice(matchAt, matchAt + highlighted.length)}</mark>{text.slice(matchAt + highlighted.length)}</> : word ? <mark className="line-highlight">{text}</mark> : text}</p><textarea aria-label={`Перевод ${stamp(line.start)}`} value={text} onChange={event => setText(event.target.value)} rows={Math.max(2, Math.ceil(text.length / 70))}/>{text.trim() !== line.translated_text && <button className="save" disabled={busy || !text.trim()} onClick={() => void onSave(text.trim())}>Сохранить перевод</button>}</div>
  </article>
}
