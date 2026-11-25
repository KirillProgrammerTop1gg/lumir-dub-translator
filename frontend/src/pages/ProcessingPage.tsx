import { useState } from 'react'
import type { Summary } from '../lib'
import { api, json, stages, stamp } from '../lib'
import { ProcessOptions } from '../components/TranscriptPanel'

type Props = { projects: Summary[]; onOpen: (id: string) => void; onRefresh: () => Promise<unknown>; onError: (message: string) => void }

export function ProcessingPage({projects, onOpen, onRefresh, onError}: Props) {
  const [device, setDevice] = useState<'cpu' | 'cuda'>('cpu')
  const [expectedSpeakers, setExpectedSpeakers] = useState<number | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const active = projects.filter(project => ['queued', 'processing'].includes(project.status))
  const available = projects.filter(project => !['queued', 'processing'].includes(project.status))

  async function start(project: Summary) {
    if (project.status === 'complete' && !window.confirm(`Повторная обработка «${project.title}» заменит текущую расшифровку и правки. Продолжить?`)) return
    setBusyId(project.id); onError('')
    try {
      await api(`/projects/${project.id}/process`, json('POST', {device, expected_speakers: expectedSpeakers, replace_existing: project.status === 'complete'}))
      await onRefresh()
    } catch (error) { onError((error as Error).message) }
    finally { setBusyId(null) }
  }

  return <><header><div><p className="eyebrow">СТУДИЯ LUMIR DUB</p><h1>Обработка видео</h1></div></header><section className="processing-section"><div className="detail-head"><p className="eyebrow">ОЧЕРЕДЬ</p><h2>Сейчас обрабатывается</h2><p>Видео выполняются по очереди. Страница обновляется автоматически.</p></div>{active.length === 0 ? <p className="processing-empty">Сейчас нет активных задач.</p> : <div className="job-list">{active.map(project => <article className="job-card" key={project.id}><div><strong>{project.title}</strong><small>{project.status === 'queued' ? 'В очереди' : stages[project.stage] || 'Обработка'} · {project.progress}%</small></div><div className="job-progress" role="progressbar" aria-label={`Прогресс ${project.title}`} aria-valuenow={project.progress} aria-valuemin={0} aria-valuemax={100}><div style={{width: `${project.progress}%`}}/></div><button onClick={() => onOpen(project.id)}>Открыть →</button></article>)}</div>}</section><section className="processing-section"><div className="detail-head"><p className="eyebrow">НОВЫЙ ЗАПУСК</p><h2>Запустить или повторить</h2><p>Выберите устройство и число говорящих. Для уже готового проекта повторный запуск заменит существующую расшифровку.</p></div><ProcessOptions {...{device, setDevice, expectedSpeakers, setExpectedSpeakers}}/>{available.length === 0 ? <p className="processing-empty">Других проектов пока нет.</p> : <div className="job-list">{available.map(project => <article className="job-card restart-card" key={project.id}><div><strong>{project.title}</strong><small>{stamp(project.duration)} · {project.status === 'complete' ? 'Готово' : project.status === 'failed' ? 'Ошибка' : 'Не обработано'}</small></div><div className="job-actions"><button className="job-open" onClick={() => onOpen(project.id)}>Открыть</button><button className="job-start" disabled={busyId !== null} onClick={() => void start(project)}>{project.status === 'ready' ? 'Запустить' : 'Обработать заново'}</button></div></article>)}</div>}</section></>
}
