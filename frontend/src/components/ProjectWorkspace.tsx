import { useEffect, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import type { AILine, Project, Segment, Speaker } from '../lib'
import { api, englishDialogue, json } from '../lib'

type Props = { project: Project; onChange: (project: Project) => void; onDeleted: () => void; onError: (message: string) => void }
export type ProjectActions = {
  project: Project
  device: 'cpu' | 'cuda'
  setDevice: (value: 'cpu' | 'cuda') => void
  expectedSpeakers: number | null
  setExpectedSpeakers: (value: number | null) => void
  busy: boolean
  saved: string
  process: (replaceExisting?: boolean) => Promise<boolean>
  saveSegment: (segment: Segment, text: string, speakerId: string | null) => void
  mergeSegments: (segments: Segment[], speakerId: string | null) => Promise<boolean>
  assignSpeaker: (segments: Segment[], speakerId: string | null) => Promise<boolean>
  splitSegment: (segment: Segment, text: string, splitAt: number, firstSpeakerId: string | null, secondSpeakerId: string | null) => Promise<boolean>
  renameSpeaker: (speaker: Speaker, name: string) => Promise<boolean>
  deleteSpeaker: (speaker: Speaker) => Promise<boolean>
  addSpeaker: (name: string) => Promise<string | null>
  saveTitle: (title: string) => Promise<boolean>
  saveAIConfig: (contextNotes: string, targetLanguage: string, provider: 'ollama' | 'openrouter') => Promise<boolean>
  runAI: () => Promise<boolean>
  saveAILine: (line: AILine, translatedText: string) => Promise<boolean>
  remove: () => Promise<void>
  download: (format: 'srt' | 'txt' | 'json' | 'translated-srt' | 'translated-txt' | 'dialogue-txt' | 'english-dialogue-txt') => Promise<void>
  onError: (message: string) => void
}

export function ProjectWorkspace({project, onChange, onDeleted, onError}: Props) {
  const [device, setDevice] = useState<'cpu' | 'cuda'>(project.device === 'cuda' ? 'cuda' : 'cpu')
  const [expectedSpeakers, setExpectedSpeakers] = useState<number | null>(project.expected_speakers)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState('Все изменения сохранены')
  const navigate = useNavigate()
  const base = `/projects/${project.id}`

  useEffect(() => { setDevice(project.device === 'cuda' ? 'cuda' : 'cpu'); setExpectedSpeakers(project.expected_speakers) }, [project.id])

  async function update(path: string, init: RequestInit): Promise<boolean> {
    setBusy(true); onError('')
    try { onChange(await api<Project>(path, init)); setSaved('Все изменения сохранены'); return true }
    catch (error) { onError((error as Error).message); setSaved('Ошибка сохранения'); return false }
    finally { setBusy(false) }
  }
  async function process(replaceExisting = false) {
    return update(`${base}/process`, json('POST', {device, expected_speakers: expectedSpeakers, replace_existing: replaceExisting}))
  }
  function saveSegment(segment: Segment, text: string, speakerId: string | null) {
    setSaved('Сохраняем…')
    void update(`${base}/segments/${segment.id}`, json('PATCH', {text, speaker_id: speakerId}))
  }
  async function mergeSegments(segments: Segment[], speakerId: string | null) {
    return update(`${base}/segments/merge`, json('POST', {segment_ids: segments.map(segment => segment.id), speaker_id: speakerId}))
  }
  async function assignSpeaker(segments: Segment[], speakerId: string | null) {
    return update(`${base}/segments/speaker/bulk`, json('PATCH', {segment_ids: segments.map(segment => segment.id), speaker_id: speakerId}))
  }
  async function splitSegment(segment: Segment, text: string, splitAt: number, firstSpeakerId: string | null, secondSpeakerId: string | null) {
    return update(`${base}/segments/${segment.id}/split`, json('POST', {text, split_at: [...text.slice(0, splitAt)].length, first_speaker_id: firstSpeakerId, second_speaker_id: secondSpeakerId}))
  }
  async function renameSpeaker(speaker: Speaker, name: string) {
    if (!name.trim() || name.trim() === speaker.name) return true
    return update(`${base}/speakers/${speaker.id}`, json('PATCH', {name: name.trim()}))
  }
  async function deleteSpeaker(speaker: Speaker) {
    return update(`${base}/speakers/${encodeURIComponent(speaker.id)}`, {method: 'DELETE'})
  }
  async function addSpeaker(name: string) {
    if (!name.trim()) return null
    setBusy(true); onError('')
    try {
      const updated = await api<Project>(`${base}/speakers`, json('POST', {name: name.trim()}))
      onChange(updated); setSaved('Все изменения сохранены')
      return updated.speakers.find(speaker => !project.speakers.some(previous => previous.id === speaker.id))?.id ?? null
    } catch (error) { onError((error as Error).message); setSaved('Ошибка сохранения'); return null }
    finally { setBusy(false) }
  }
  async function saveTitle(title: string) {
    if (!title.trim()) return false
    return update(base, json('PATCH', {title: title.trim()}))
  }
  async function saveAIConfig(contextNotes: string, targetLanguage: string, provider: 'ollama' | 'openrouter') {
    return update(`${base}/ai/config`, json('PATCH', {context_notes: contextNotes, target_language: targetLanguage, ai_provider: provider}))
  }
  async function runAI() {
    return update(`${base}/ai/run`, {method: 'POST'})
  }
  async function saveAILine(line: AILine, translatedText: string) {
    return update(`${base}/ai/lines/${line.id}`, json('PATCH', {translated_text: translatedText}))
  }
  async function remove() {
    if (!window.confirm(`Удалить проект «${project.title}» вместе с видео и расшифровкой?`)) return
    setBusy(true); onError('')
    try { await api<void>(base, {method: 'DELETE'}); onDeleted(); navigate('/projects') }
    catch (error) { onError((error as Error).message) }
    finally { setBusy(false) }
  }
  async function download(format: 'srt' | 'txt' | 'json' | 'translated-srt' | 'translated-txt' | 'dialogue-txt' | 'english-dialogue-txt') {
    onError('')
    try {
      let blob: Blob
      if (format === 'english-dialogue-txt') {
        if (!project.segments.length) throw new Error('Транскрипция ещё не готова')
        blob = new Blob([englishDialogue(project)], {type: 'text/plain;charset=utf-8'})
      } else {
        const response = await fetch(`/api${base}/export/${format}`)
        if (!response.ok) {
          const error = await response.json().catch(() => ({}))
          throw new Error(typeof error.detail === 'string' ? error.detail : `Ошибка ${response.status}`)
        }
        blob = await response.blob()
      }
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url; link.download = format === 'dialogue-txt' ? 'dialogue-ru.txt' : format === 'english-dialogue-txt' ? 'dialogue-en.txt' : format.startsWith('translated-') ? `translation.${format.split('-')[1]}` : `transcript.${format}`
      document.body.append(link); link.click(); link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) { onError((error as Error).message) }
  }

  const actions: ProjectActions = {project, device, setDevice, expectedSpeakers, setExpectedSpeakers, busy, saved, process, saveSegment, mergeSegments, assignSpeaker, splitSegment, renameSpeaker, deleteSpeaker, addSpeaker, saveTitle, saveAIConfig, runAI, saveAILine, remove, download, onError}
  return <>
    <header className="project-header"><div><p className="eyebrow">СТУДИЯ LUMIR DUB / ПРОЕКТ</p><h1>{project.title}</h1></div><span className="save-status" aria-live="polite">✓ {saved}</span></header>
    <nav className="project-tabs" aria-label="Разделы проекта">
      <NavLink to={`${base}/transcript`} className={({isActive}) => isActive ? 'active' : ''}>Транскрипт</NavLink>
      <NavLink to={`${base}/speakers`} className={({isActive}) => isActive ? 'active' : ''}>Говорящие <span>{project.speakers.length}</span></NavLink>
      <NavLink to={`${base}/settings`} className={({isActive}) => isActive ? 'active' : ''}>Проект и экспорт</NavLink>
      <NavLink to={`${base}/translation`} className={({isActive}) => isActive ? 'active' : ''}>AI-перевод</NavLink>
    </nav>
    <Outlet context={actions}/>
  </>
}
