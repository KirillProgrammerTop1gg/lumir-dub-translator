import { useState } from 'react'
import { useNavigate, useOutletContext } from 'react-router-dom'
import type { ProjectActions } from '../components/ProjectWorkspace'
import { ProcessOptions } from '../components/TranscriptPanel'

export function SpeakersPage() {
  const actions = useOutletContext<ProjectActions>()
  const {project, device, setDevice, expectedSpeakers, setExpectedSpeakers, busy} = actions
  const [name, setName] = useState('')
  const navigate = useNavigate()
  async function addSpeaker() { if (await actions.addSpeaker(name)) setName('') }
  async function deleteSpeaker(speaker: typeof project.speakers[number]) {
    await actions.deleteSpeaker(speaker)
  }
  async function rerun() {
    if (!window.confirm('Повторная обработка заменит текущую расшифровку и ручные правки. Продолжить?')) return
    if (await actions.process(true)) navigate(`/projects/${project.id}/transcript`)
  }
  return <section className="detail-panel"><div className="detail-head"><p className="eyebrow">ПЕРСОНАЖИ</p><h2>Говорящие в видео</h2><p>Исправьте имена, добавьте или удалите персонажа. Реплики удалённого персонажа сохранятся без говорящего.</p></div><div className="speaker-grid">{project.speakers.map((speaker, index) => <div className="speaker-card" key={speaker.id}><div className="avatar" style={{background: ['#d20091','#8e4dff','#a8006f','#3a12a0'][index % 4]}}>{index + 1}</div><div><small>{speaker.id}</small><input aria-label={`Имя ${speaker.id}`} defaultValue={speaker.name} key={speaker.name} onBlur={event => {void actions.renameSpeaker(speaker, event.target.value)}} onKeyDown={event => {if (event.key === 'Enter') event.currentTarget.blur()}}/></div><button className="delete-speaker" type="button" disabled={busy || project.status === 'queued' || project.status === 'processing' || project.ai_status === 'processing'} aria-label={`Удалить говорящего ${speaker.name}`} onClick={() => void deleteSpeaker(speaker)}>Удалить</button></div>)}</div><form className="add-speaker" onSubmit={event => {event.preventDefault(); void addSpeaker()}}><input aria-label="Имя нового говорящего" value={name} onChange={event => setName(event.target.value)} placeholder="Имя нового персонажа" maxLength={100}/><button className="primary" disabled={busy || !name.trim()}>+ Добавить</button></form>{project.status === 'complete' && <div className="retry-box"><h3>Голоса объединились?</h3><p>Укажите количество говорящих и запустите обработку заново. Это заменит текущий текст и ручные правки.</p><ProcessOptions {...{device, setDevice, expectedSpeakers, setExpectedSpeakers}}/><button className="primary" disabled={busy} onClick={() => void rerun()}>Обработать заново</button></div>}</section>
}
