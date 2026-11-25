import { useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import type { ProjectActions } from '../components/ProjectWorkspace'

export function SettingsPage() {
  const actions = useOutletContext<ProjectActions>()
  const {project, busy} = actions
  const [title, setTitle] = useState(project.title || project.filename)
  useEffect(() => { setTitle(project.title || project.filename) }, [project.title, project.filename])
  const canExport = project.segments.length > 0
  return <section className="detail-panel"><div className="detail-head"><p className="eyebrow">ПРОЕКТ</p><h2>Сохранение и экспорт</h2><p>Правки реплик сохраняются автоматически. Название проекта можно изменить ниже.</p></div><div className="project-settings"><label>Название проекта<input value={title} maxLength={120} onChange={event => setTitle(event.target.value)}/></label><button className="primary" disabled={busy || !title.trim() || title.trim() === project.title} onClick={() => void actions.saveTitle(title)}>Сохранить название</button></div><div className="export-box"><h3>Выгрузить транскрипцию</h3><p>{canExport ? 'SRT — субтитры; TXT — отдельные реплики с таймкодами; английский диалог — одна строка на говорящего до смены голоса; JSON — полный проект.' : 'Экспорт станет доступен после появления расшифровки.'}</p><div className="export-actions">{(['srt','txt','json'] as const).map(format => <button key={format} className="export-link" disabled={!canExport} onClick={() => void actions.download(format)}>{format.toUpperCase()} ↓</button>)}<button className="export-link" disabled={!canExport} onClick={() => void actions.download('english-dialogue-txt')}>Английский диалог · без таймкодов ↓</button></div></div><div className="danger-zone"><h3>Удалить проект</h3><p>Видео и расшифровка будут удалены с этого компьютера.</p><button disabled={busy || ['queued','processing'].includes(project.status)} onClick={() => void actions.remove()}>Удалить проект</button></div></section>
}
