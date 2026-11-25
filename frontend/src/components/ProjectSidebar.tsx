import { Brand } from './Brand'
import { NavLink } from 'react-router-dom'
import type { Summary } from '../lib'
import { stamp } from '../lib'

type Props = { projects: Summary[]; selectedId?: string; busy: boolean; onSelect: (id: string) => void; onUpload: (file?: File) => void; onHome: () => void }

export function ProjectSidebar({projects, selectedId, busy, onSelect, onUpload, onHome}: Props) {
  return <aside className="sidebar">
    <button className="brand-button" onClick={onHome} aria-label="На главную"><Brand /></button>
    <nav className="global-nav" aria-label="Навигация"><NavLink to="/projects" end className={({isActive}) => isActive ? 'active' : ''}>▦ Все проекты</NavLink><NavLink to="/processing" className={({isActive}) => isActive ? 'active' : ''}>◉ Обработка {projects.filter(project => ['queued','processing'].includes(project.status)).length > 0 && <span>{projects.filter(project => ['queued','processing'].includes(project.status)).length}</span>}</NavLink><NavLink to="/env" className={({isActive}) => isActive ? 'active' : ''}>⚙ Настройки .env</NavLink></nav>
    <p className="side-label">ПРОЕКТЫ</p>
    <label className="upload">+ Новый проект<input type="file" accept=".mp4,.mkv,.mov,.webm" disabled={busy} onChange={e => {onUpload(e.target.files?.[0]); e.target.value = ''}} /></label>
    <nav className="project-list" aria-label="Проекты">
      {projects.map(project => <button key={project.id} className={selectedId === project.id ? 'project-item selected' : 'project-item'} onClick={() => onSelect(project.id)}><span aria-hidden="true">▣</span><span className="project-name">{project.title}<small>{stamp(project.duration)} · {project.status === 'complete' ? 'Готово' : project.status === 'failed' ? 'Ошибка' : project.status === 'ready' ? 'Не обработано' : project.status === 'queued' ? 'В очереди' : 'Обработка'}</small></span></button>)}
      {projects.length === 0 && <p className="nav-empty">Здесь появятся ваши видео</p>}
    </nav>
    <div className="sidebar-foot">Локальная студия транскрипции</div>
  </aside>
}
