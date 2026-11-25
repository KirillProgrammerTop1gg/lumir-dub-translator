import { useEffect, useRef, useState } from 'react'
import type { Project, Segment, Speaker } from '../lib'
import { stages, stamp } from '../lib'

type Props = { project: Project; device: 'cpu' | 'cuda'; setDevice: (device: 'cpu' | 'cuda') => void; expectedSpeakers: number | null; setExpectedSpeakers: (count: number | null) => void; busy: boolean; onProcess: (replaceExisting?: boolean) => void; onSaveSegment: (segment: Segment, text: string, speakerId: string | null) => void; onMergeSegments: (segments: Segment[], speakerId: string | null) => Promise<boolean>; onAssignSpeaker: (segments: Segment[], speakerId: string | null) => Promise<boolean>; onSplitSegment: (segment: Segment, text: string, splitAt: number, firstSpeakerId: string | null, secondSpeakerId: string | null) => Promise<boolean>; onError: (message: string) => void }

export function TranscriptPanel({project, device, setDevice, expectedSpeakers, setExpectedSpeakers, busy, onProcess, onSaveSegment, onMergeSegments, onAssignSpeaker, onSplitSegment, onError}: Props) {
  const [active, setActive] = useState<string | null>(null)
  const [follow, setFollow] = useState(true)
  const [speakerFilter, setSpeakerFilter] = useState('all')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [mergeSpeaker, setMergeSpeaker] = useState<string>('')
  const [assignedSpeaker, setAssignedSpeaker] = useState<string>('')
  const video = useRef<HTMLVideoElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const visibleSegments = project.segments.filter(segment => speakerFilter === 'all' || (speakerFilter === 'unknown' ? segment.speaker_id === null : segment.speaker_id === speakerFilter))

  useEffect(() => { setActive(null); setFollow(true); setSpeakerFilter('all'); setSelectedIds([]); setAssignedSpeaker(''); setMergeSpeaker('') }, [project.id])
  useEffect(() => {
    const container = list.current
    if (!container || !follow || !active) return
    const row = Array.from(container.children).find(child => (child as HTMLElement).dataset.segmentId === active) as HTMLElement | undefined
    if (!row) return
    const box = container.getBoundingClientRect()
    const target = row.getBoundingClientRect()
    container.scrollTo({top: container.scrollTop + target.top - box.top - (container.clientHeight - target.height) / 2, behavior: 'smooth'})
  }, [active, follow, project.id, speakerFilter])

  function seek(segment: Segment) {
    setFollow(true)
    if (video.current) { video.current.currentTime = segment.start; video.current.play().catch(() => {}) }
    setActive(segment.id)
  }
  function updateActive() {
    const time = video.current?.currentTime ?? 0
    const segment = project.segments.find(s => s.start <= time && s.end >= time)
    setActive(segment?.id ?? null)
  }
  async function mergeSelected() {
    const selected = project.segments.filter(segment => selectedIds.includes(segment.id))
    const positions = selected.map(segment => project.segments.indexOf(segment))
    if (selected.length < 2 || positions.some((position, index) => index > 0 && position !== positions[index - 1] + 1)) {
      onError('Выберите минимум две соседние реплики подряд')
      return
    }
    if (await onMergeSegments(selected, mergeSpeaker === 'unknown' ? null : mergeSpeaker || selected[0].speaker_id)) {setSelectedIds([]); setMergeSpeaker('')}
  }
  async function assignSelected() {
    if (!assignedSpeaker) {onError('Выберите говорящего для отмеченных реплик'); return}
    const selected = project.segments.filter(segment => selectedIds.includes(segment.id))
    if (await onAssignSpeaker(selected, assignedSpeaker === 'unknown' ? null : assignedSpeaker)) {setSelectedIds([]); setAssignedSpeaker('')}
  }
  return <div className="workspace">
    <section className="player-card"><video ref={video} controls src={`/api/projects/${project.id}/video`} onTimeUpdate={updateActive} /><div className="video-info"><span>{project.filename}</span><span>{stamp(project.duration)}</span></div></section>
    <section className="transcript"><div className="section-head"><div><p className="eyebrow">ТРАНСКРИПТ</p><h2>Реплики <span>{project.segments.length}</span></h2></div>{project.status === 'complete' && <button className="follow-button" type="button" aria-pressed={follow} onClick={() => setFollow(true)}>{follow ? '● Следим за видео' : '↘ К текущей реплике'}</button>}</div>
      {project.status === 'complete' && project.segments.length > 0 && <div className="transcript-filters">
        <label>Фильтр <select aria-label="Фильтр говорящих" value={speakerFilter} onChange={event => {setSpeakerFilter(event.target.value); setSelectedIds([])}}><option value="all">Все говорящие</option>{project.speakers.map(speaker => <option key={speaker.id} value={speaker.id}>{speaker.name}</option>)}<option value="unknown">Неизвестно</option></select></label>
        <small>Показано {visibleSegments.length} из {project.segments.length}</small>
        {selectedIds.length > 0 && <div className="speaker-assignment">
          <label>Назначить выбранным<select aria-label="Говорящий для назначения" value={assignedSpeaker} onChange={event => setAssignedSpeaker(event.target.value)}><option value="">Выберите говорящего</option>{project.speakers.map(speaker => <option key={speaker.id} value={speaker.id}>{speaker.name}</option>)}<option value="unknown">Неизвестно</option></select></label>
          <button type="button" disabled={busy || !assignedSpeaker} onClick={() => void assignSelected()}>Назначить говорящего ({selectedIds.length})</button>
        </div>}
        {selectedIds.length > 1 && <label>При объединении<select aria-label="Говорящий объединённой реплики" value={mergeSpeaker} onChange={event => setMergeSpeaker(event.target.value)}><option value="">Как у первой</option>{project.speakers.map(speaker => <option key={speaker.id} value={speaker.id}>{speaker.name}</option>)}<option value="unknown">Неизвестно</option></select></label>}
        <button type="button" disabled={busy || selectedIds.length < 2} onClick={() => void mergeSelected()}>Объединить выбранные ({selectedIds.length})</button>
      </div>}
      {project.status === 'ready' || project.status === 'failed' ? <div className="process-panel"><h3>{project.status === 'failed' ? 'Обработка не удалась' : 'Готово к обработке'}</h3><p>{project.error || 'Укажите число говорящих, если оно известно, и запустите распознавание.'}</p>{project.error?.includes('pyannote') && <a className="model-link" href="https://huggingface.co/pyannote/speaker-diarization-community-1" target="_blank" rel="noreferrer">Открыть страницу модели ↗</a>}<ProcessOptions {...{device, setDevice, expectedSpeakers, setExpectedSpeakers}}/><button className="primary start-button" disabled={busy} onClick={() => onProcess()}>Начать обработку</button></div> : project.status === 'queued' || project.status === 'processing' ? <div className="process-panel"><div className="spinner"/><h3>Обрабатываем видео</h3><p>{stages[project.stage] || 'Обработка'} · {project.progress}%</p><div className="progress-track" role="progressbar" aria-label="Прогресс обработки" aria-valuenow={project.progress} aria-valuemin={0} aria-valuemax={100}><div style={{width: `${project.progress}%`}}/></div><small>При загрузке моделей прогресс может временно не меняться.</small></div> : <div className="segments" ref={list} onWheel={() => setFollow(false)} onTouchStart={() => setFollow(false)} onPointerDown={() => setFollow(false)} onKeyDown={event => {if (['ArrowUp','ArrowDown','PageUp','PageDown','Home','End'].includes(event.key)) setFollow(false)}} tabIndex={0} aria-label="Список реплик с прокруткой">{project.segments.length === 0 ? <p className="muted">Речь не найдена.</p> : visibleSegments.length === 0 ? <p className="muted">У этого говорящего реплик пока нет.</p> : visibleSegments.map(segment => <SegmentRow key={segment.id} segment={segment} selected={selectedIds.includes(segment.id)} onSelect={() => setSelectedIds(ids => ids.includes(segment.id) ? ids.filter(id => id !== segment.id) : [...ids, segment.id])} speakers={project.speakers} active={active === segment.id} busy={busy} onSeek={() => seek(segment)} onSave={onSaveSegment} onSplit={onSplitSegment} onError={onError}/>)}</div>}
    </section>
  </div>
}

export function ProcessOptions({device, setDevice, expectedSpeakers, setExpectedSpeakers}: Pick<Props, 'device' | 'setDevice' | 'expectedSpeakers' | 'setExpectedSpeakers'>) {
  return <div className="process-options"><label>Устройство<select value={device} onChange={e => setDevice(e.target.value as 'cpu' | 'cuda')}><option value="cpu">CPU</option><option value="cuda">NVIDIA GPU</option></select></label><label>Говорящих<select value={expectedSpeakers ?? ''} onChange={e => setExpectedSpeakers(e.target.value ? Number(e.target.value) : null)}><option value="">Авто</option>{[1,2,3,4,5,6,7,8].map(count => <option key={count} value={count}>{count}</option>)}</select></label><small>Если модель объединила двух героев, выберите 2.</small></div>
}

function SegmentRow({segment, selected, onSelect, speakers, active, busy, onSeek, onSave, onSplit, onError}: {segment: Segment; selected: boolean; onSelect: () => void; speakers: Speaker[]; active: boolean; busy: boolean; onSeek: () => void; onSave: Props['onSaveSegment']; onSplit: Props['onSplitSegment']; onError: Props['onError']}) {
  const [text, setText] = useState(segment.text)
  const [speaker, setSpeaker] = useState(segment.speaker_id)
  const [secondSpeaker, setSecondSpeaker] = useState(segment.speaker_id)
  const [splitting, setSplitting] = useState(false)
  const [splitAt, setSplitAt] = useState<number | null>(null)
  useEffect(() => { setText(segment.text); setSpeaker(segment.speaker_id); setSecondSpeaker(segment.speaker_id) }, [segment.text, segment.speaker_id])
  const changed = text.trim() !== segment.text || speaker !== segment.speaker_id
  const validSplit = splitAt !== null && splitAt > 0 && splitAt < text.length && (text[splitAt - 1]?.trim() === '' || text[splitAt]?.trim() === '') && Boolean(text.slice(0, splitAt).trim()) && Boolean(text.slice(splitAt).trim())
  async function split() {
    if (!validSplit || splitAt === null) {onError('Поставьте курсор между словами в тексте реплики'); return}
    if (await onSplit(segment, text, splitAt, speaker, secondSpeaker)) {setSplitting(false); setSplitAt(null)}
  }
  return <article data-segment-id={segment.id} className={`segment${active ? ' active' : ''}${selected ? ' selected-for-merge' : ''}`}><label className="merge-check"><input type="checkbox" aria-label={`Выбрать реплику ${stamp(segment.start)}`} checked={selected} disabled={busy} onChange={onSelect}/></label><button className="time" onClick={onSeek}>{stamp(segment.start)}</button><div className="segment-body"><select aria-label={`Говорящий реплики ${stamp(segment.start)}`} value={speaker ?? ''} onChange={e => setSpeaker(e.target.value || null)}><option value="">Неизвестно</option>{speakers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select><textarea aria-label={`Текст реплики ${stamp(segment.start)}`} rows={Math.max(2, Math.ceil(text.length / 65))} value={text} onChange={e => setText(e.target.value)} onSelect={e => setSplitAt(e.currentTarget.selectionStart)}/><div className="segment-actions">{changed && <button className="save" disabled={busy || !text.trim()} onClick={() => {if (text.trim()) onSave(segment, text.trim(), speaker); else onError('Текст реплики не может быть пустым')}}>Сохранить правку</button>}<button disabled={busy} onClick={() => setSplitting(value => !value)}>{splitting ? 'Отмена разделения' : 'Разделить'}</button></div>{splitting && <div className="split-editor"><p>Поставьте курсор между словами в поле текста. Место разделения показано ниже.</p>{validSplit && <div className="split-preview"><span>{text.slice(0, splitAt!).trim()}</span><span>{text.slice(splitAt!).trim()}</span></div>}<label>Говорящий второй реплики<select value={secondSpeaker ?? ''} onChange={event => setSecondSpeaker(event.target.value || null)}><option value="">Неизвестно</option>{speakers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button className="save" disabled={busy || !validSplit} onClick={() => void split()}>Подтвердить разделение</button></div>}</div></article>
}
