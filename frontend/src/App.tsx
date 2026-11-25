import { useEffect, useRef, useState, type DragEvent } from 'react'
import { Navigate, Route, Routes, useLocation, useMatch, useNavigate } from 'react-router-dom'
import { ProjectSidebar } from './components/ProjectSidebar'
import { ProjectWorkspace } from './components/ProjectWorkspace'
import { ProjectsPage } from './pages/ProjectsPage'
import { TranscriptPage } from './pages/TranscriptPage'
import { SpeakersPage } from './pages/SpeakersPage'
import { SettingsPage } from './pages/SettingsPage'
import { ProcessingPage } from './pages/ProcessingPage'
import { TranslationPage } from './pages/TranslationPage'
import { EnvSettingsPage } from './pages/EnvSettingsPage'
import { api, json, normalizeProject, normalizeSummary, type Project, type Summary } from './lib'
import './style.css'

export function Shell() {
  const navigate = useNavigate()
  const location = useLocation()
  const projectId = useMatch('/projects/:projectId/*')?.params.projectId
  const [projects, setProjects] = useState<Summary[]>([])
  const [project, setProject] = useState<Project | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const hasActiveJobs = projects.some(value => value.status === 'queued' || value.status === 'processing')

  const refreshList = () => api<Summary[]>('/projects').then(values => setProjects(values.map(normalizeSummary))).catch(error => setMessage(error.message))
  function receiveProject(value: Project) {
    if (!value.title) setMessage('Backend запущен со старой версией. Перезапустите lumir-api, чтобы работали сохранение проекта и экспорт.')
    setProject(normalizeProject(value))
  }
  useEffect(() => { refreshList() }, [])
  useEffect(() => {
    api<{revision: number}>('/version').then(value => {
      if (value.revision !== 7) setMessage('Backend запущен со старой версией. Перезапустите lumir-api, чтобы работали словарь и обновлённый перевод.')
    }).catch(() => setMessage('Backend запущен со старой версией или недоступен. Перезапустите lumir-api.'))
  }, [])
  useEffect(() => {
    if (location.pathname !== '/processing' && !hasActiveJobs) return
    void refreshList()
    const timer = window.setInterval(() => {void refreshList()}, 2000)
    return () => window.clearInterval(timer)
  }, [location.pathname, hasActiveJobs])
  useEffect(() => {
    if (!projectId) { setProject(null); return }
    let cancelled = false
    setProject(null)
    api<Project>(`/projects/${projectId}`).then(value => {if (!cancelled) receiveProject(value)}).catch(error => {if (!cancelled) {setMessage(error.message); navigate('/projects')}})
    return () => {cancelled = true}
  }, [projectId, navigate])
  useEffect(() => {
    if (!projectId || project?.id !== projectId || (!['queued','processing'].includes(project.status) && project.ai_status !== 'processing')) return
    let cancelled = false
    const timer = window.setInterval(() => {
      api<Project>(`/projects/${projectId}`).then(value => {if (!cancelled) {receiveProject(value); refreshList()}}).catch(error => {if (!cancelled) setMessage(error.message)})
    }, 2000)
    return () => {cancelled = true; window.clearInterval(timer)}
  }, [projectId, project?.id, project?.status, project?.ai_status])

  async function upload(file?: File) {
    if (!file || busy) return
    setBusy(true); setMessage('')
    try {
      const form = new FormData(); form.append('file', file)
      const created = await api<Project>('/projects', {method: 'POST', body: form})
      receiveProject(created); await refreshList()
      navigate(`/projects/${created.id}/transcript`)
    } catch (error) { setMessage((error as Error).message) }
    finally { setBusy(false) }
  }
  function dragEnter(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault(); dragDepth.current += 1; setDragging(true)
  }
  function dragLeave(event: DragEvent<HTMLDivElement>) {
    event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }
  function dragOver(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault(); event.dataTransfer.dropEffect = busy ? 'none' : 'copy'
  }
  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault(); dragDepth.current = 0; setDragging(false)
    if (!busy) void upload(event.dataTransfer.files[0])
  }
  function updated(value: Project) { receiveProject(value); void refreshList() }
  function deleted() { setProject(null); void refreshList() }
  async function rename(id: string, title: string) {
    setMessage('')
    try {
      const value = await api<Project>(`/projects/${id}`, json('PATCH', {title}))
      if (project?.id === id) receiveProject(value)
      await refreshList()
      return true
    } catch (error) { setMessage((error as Error).message); return false }
  }

  return <div className="shell" onDragEnter={dragEnter} onDragLeave={dragLeave} onDragOver={dragOver} onDrop={drop}>
    {dragging && <div className="drop-overlay" aria-hidden="true"><div>Отпустите видео для загрузки</div></div>}
    <ProjectSidebar projects={projects} selectedId={projectId} busy={busy} onSelect={id => navigate(`/projects/${id}/transcript`)} onUpload={upload} onHome={() => navigate('/projects')}/>
    <main className="main">
      {message && <div className="notice error" role="alert">{message}<button onClick={() => setMessage('')} aria-label="Закрыть сообщение">×</button></div>}
      <Routes>
        <Route path="/" element={<Navigate to="/projects" replace/>}/>
        <Route path="/projects" element={<ProjectsPage projects={projects} busy={busy} onUpload={upload} onOpen={id => navigate(`/projects/${id}/transcript`)} onRename={rename}/>}/>
        <Route path="/processing" element={<ProcessingPage projects={projects} onOpen={id => navigate(`/projects/${id}/transcript`)} onRefresh={refreshList} onError={setMessage}/>}/>
        <Route path="/env" element={<EnvSettingsPage/>}/>
        <Route path="/projects/:projectId" element={project && project.id === projectId ? <ProjectWorkspace key={project.id} project={project} onChange={updated} onDeleted={deleted} onError={setMessage}/> : <div className="page-loading">Загружаем проект…</div>}>
          <Route index element={<Navigate to="transcript" replace/>}/>
          <Route path="transcript" element={<TranscriptPage/>}/>
          <Route path="speakers" element={<SpeakersPage/>}/>
          <Route path="settings" element={<SettingsPage/>}/>
          <Route path="translation" element={<TranslationPage/>}/>
        </Route>
        <Route path="*" element={<Navigate to="/projects" replace/>}/>
      </Routes>
    </main>
  </div>
}
