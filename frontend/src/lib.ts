export type Speaker = { id: string; name: string }
export type Word = { text: string; start?: number; end?: number; speaker_id?: string }
export type Segment = { id: string; start: number; end: number; text: string; original_text: string; speaker_id: string | null; words: Word[] }
export type AILine = { id: string; segment_ids: string[]; start: number; end: number; speaker_id: string | null; source_text: string; translated_text: string; word_links?: {english: string; russian: string}[] }
export type Project = { id: string; filename: string; title: string; duration: number; status: string; stage: string; progress: number; device: string | null; expected_speakers: number | null; error: string | null; speakers: Speaker[]; segments: Segment[]; context_notes: string; target_language: string; ai_provider: 'ollama' | 'openrouter'; ai_status: string; ai_error: string | null; ai_progress: number; ai_lines: AILine[] }
export type Summary = Pick<Project, 'id' | 'filename' | 'title' | 'duration' | 'status' | 'device' | 'expected_speakers' | 'progress' | 'stage' | 'error'>

export function normalizeProject(project: Project): Project {
  return {...project, title: project.title || project.filename, expected_speakers: project.expected_speakers ?? null, progress: project.progress ?? 0, stage: project.stage || project.status, speakers: project.speakers ?? [], segments: project.segments ?? [], context_notes: project.context_notes ?? '', target_language: project.target_language || 'Russian', ai_provider: project.ai_provider || 'ollama', ai_status: project.ai_status || 'idle', ai_error: project.ai_error ?? null, ai_progress: project.ai_progress ?? 0, ai_lines: project.ai_lines ?? []}
}
export function normalizeSummary(project: Summary): Summary {
  return {...project, title: project.title || project.filename, device: project.device ?? null, expected_speakers: project.expected_speakers ?? null, progress: project.progress ?? 0, stage: project.stage || project.status, error: project.error ?? null}
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init)
  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(typeof error.detail === 'string' ? error.detail : `Ошибка ${response.status}`)
  }
  return response.status === 204 ? undefined as T : response.json()
}
export const json = (method: string, body: object): RequestInit => ({method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)})
export const stamp = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`
export const stages: Record<string, string> = {queued: 'Ожидание', loading: 'Загрузка моделей', access: 'Проверка доступа к модели', audio: 'Подготовка аудио', transcribing: 'Распознавание речи', aligning: 'Выравнивание слов', diarizing: 'Определение говорящих', saving: 'Сохранение результата'}

export function englishDialogue(project: Project): string {
  const names = new Map(project.speakers.map(speaker => [speaker.id, speaker.name]))
  const lines: string[] = []
  let currentName: string | null = null
  let parts: string[] = []
  for (const segment of project.segments) {
    const name = names.get(segment.speaker_id || '') || 'Неизвестно'
    if (parts.length && name !== currentName) {
      lines.push(`${currentName} — ${parts.join(' ')}`)
      parts = []
    }
    currentName = name
    if (segment.text.trim()) parts.push(segment.text.trim())
  }
  if (parts.length) lines.push(`${currentName} — ${parts.join(' ')}`)
  return lines.join('\n') + (lines.length ? '\n' : '')
}
