import { useEffect, useState } from 'react'
import type { Summary } from '../lib'
import { stamp } from '../lib'

type Props = { projects: Summary[]; busy: boolean; onUpload: (file?: File) => void; onOpen: (id: string) => void; onRename: (id: string, title: string) => Promise<boolean> }

export function ProjectsPage({projects, busy, onUpload, onOpen, onRename}: Props) {
  return <><header><div><p className="eyebrow">СТУДИЯ LUMIR DUB</p><h1>Проекты</h1></div></header>
    {projects.length > 0 && <section className="projects-grid" aria-label="Все проекты">{projects.map(project => <ProjectCard key={project.id} project={project} onOpen={onOpen} onRename={onRename}/>)}</section>}
    <section className={projects.length ? 'empty compact' : 'empty'}><img className="empty-mascot" src="/lumir-mascot.png" alt=""/><h2>{projects.length ? 'Добавить видео' : 'Начните с видео'}</h2><p>Перетащите видео сюда или выберите файл. После обработки вы сможете исправить реплики и говорящих.</p><label className="primary">Выбрать видео<input type="file" accept=".mp4,.mkv,.mov,.webm" disabled={busy} onChange={event => {onUpload(event.target.files?.[0]); event.target.value = ''}}/></label><small>MP4, MKV, MOV или WebM · до 30 минут · до 2 ГБ</small></section>
  </>
}

function ProjectCard({project, onOpen, onRename}: {project: Summary; onOpen: Props['onOpen']; onRename: Props['onRename']}) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(project.title)
  const [saving, setSaving] = useState(false)
  useEffect(() => {setTitle(project.title)}, [project.title])
  async function save() {
    if (!title.trim() || title.trim() === project.title) {setEditing(false); return}
    setSaving(true)
    if (await onRename(project.id, title.trim())) setEditing(false)
    setSaving(false)
  }
  const status = project.status === 'complete' ? 'Готово' : project.status === 'failed' ? 'Ошибка' : project.status === 'ready' ? 'Не обработано' : project.status === 'queued' ? 'В очереди' : 'Обработка'
  return <article className="project-card"><button className="project-card-main" onClick={() => onOpen(project.id)}><span className="project-card-icon">▣</span><strong>{project.title}</strong><small>{stamp(project.duration)} · {status}</small><span className="project-card-action">Открыть проект →</span></button>{editing ? <form className="rename-form" onSubmit={event => {event.preventDefault(); void save()}}><input aria-label={`Новое название ${project.title}`} value={title} maxLength={120} onChange={event => setTitle(event.target.value)} autoFocus/><button type="submit" disabled={saving || !title.trim()}>Сохранить</button><button type="button" onClick={() => {setTitle(project.title); setEditing(false)}}>Отмена</button></form> : <button className="rename-trigger" onClick={() => setEditing(true)}>Переименовать</button>}</article>
}
