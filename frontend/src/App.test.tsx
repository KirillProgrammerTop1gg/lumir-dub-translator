// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Shell } from './App'

const project = {
  id: 'demo', filename: 'demo.mp4', title: 'Demo', duration: 30, status: 'complete', stage: 'complete', progress: 100,
  device: 'cpu', expected_speakers: 2, error: null, speakers: [{id: 'SPEAKER_00', name: 'Alex'}],
  segments: [{id: 'one', start: 0, end: 1, text: 'Hello', original_text: 'Hello', speaker_id: 'SPEAKER_00', words: []}],
}
let responseProject: Record<string, unknown> = project
let providerResponse = {ollama_running: true, ollama_model_installed: true, ollama_model: 'qwen2.5:7b', openrouter_configured: true, openrouter_model: 'openrouter/free'}
let dictionaryResponse = {configured: false, translations: [] as string[], url: 'https://dictionary.cambridge.org/dictionary/english-russian/hello'}

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = String(input)
  if (path === '/api/version') return {ok: true, status: 200, json: async () => ({revision: 7})}
  if (path === '/api/projects') return {ok: true, status: 200, json: async () => [{id: 'demo', title: 'Demo', filename: 'demo.mp4', duration: 30, status: 'complete'}]}
  if (path === '/api/projects/demo' && init?.method === 'PATCH') return {ok: true, status: 200, json: async () => ({...project, title: 'Renamed'})}
  if (path === '/api/projects/demo') return {ok: true, status: 200, json: async () => responseProject}
  if (path === '/api/projects/demo/export/srt') return {ok: true, status: 200, blob: async () => new Blob(['Hello'], {type: 'text/plain'})}
  if (path === '/api/projects/demo/process' && init?.method === 'POST') return {ok: true, status: 202, json: async () => ({...project, status: 'queued'})}
  if (path === '/api/projects/demo/ai/run' && init?.method === 'POST') return {ok: true, status: 202, json: async () => ({...project, ai_status: 'processing', ai_progress: 0})}
  if (path === '/api/projects/demo/ai/config' && init?.method === 'PATCH') return {ok: true, status: 200, json: async () => ({...project, context_notes: 'A fantasy story', target_language: 'Ukrainian'})}
  if (path === '/api/ai/providers') return {ok: true, status: 200, json: async () => providerResponse}
  if (path.startsWith('/api/dictionary/cambridge?')) return {ok: true, status: 200, json: async () => dictionaryResponse}
  if (path === '/api/projects/demo/segments/one/split' && init?.method === 'POST') return {ok: true, status: 200, json: async () => responseProject}
  if (path === '/api/projects/demo/segments/merge' && init?.method === 'POST') return {ok: true, status: 200, json: async () => responseProject}
  if (path === '/api/projects/demo/speakers' && init?.method === 'POST') {
    responseProject = {...responseProject, speakers: [...((responseProject.speakers as typeof project.speakers) || []), {id: 'MANUAL_NEW', name: 'Sam'}]}
    return {ok: true, status: 201, json: async () => responseProject}
  }
  if (path === '/api/projects/demo/speakers/SPEAKER_00' && init?.method === 'DELETE') {
    responseProject = {...responseProject, speakers: [], segments: (responseProject.segments as typeof project.segments).map(segment => ({...segment, speaker_id: null}))}
    return {ok: true, status: 200, json: async () => responseProject}
  }
  if (path === '/api/projects/demo/segments/speaker/bulk' && init?.method === 'PATCH') {
    const body = JSON.parse(String(init.body))
    responseProject = {...responseProject, segments: (responseProject.segments as typeof project.segments).map(segment => body.segment_ids.includes(segment.id) ? {...segment, speaker_id: body.speaker_id} : segment)}
    return {ok: true, status: 200, json: async () => responseProject}
  }
  if (path === '/api/settings/env' && init?.method === 'PATCH') return {ok: true, status: 200, json: async () => ({hf_token: {configured: true, source: 'dotenv'}, openai_api_key: {configured: false, source: 'missing'}, openai_model: {value: 'gpt-4o-mini', source: 'default'}, cambridge_api_key: {configured: true, source: 'dotenv'}, cambridge_dictionary_code: {value: 'english-russian', source: 'default'}})}
  if (path === '/api/settings/env') return {ok: true, status: 200, json: async () => ({hf_token: {configured: false, source: 'missing'}, openai_api_key: {configured: false, source: 'missing'}, openai_model: {value: 'gpt-4o-mini', source: 'default'}, cambridge_api_key: {configured: false, source: 'missing'}, cambridge_dictionary_code: {value: 'english-russian', source: 'default'}})}
  throw new Error(`Unexpected request: ${path}`)
})

beforeEach(() => {
  fetchMock.mockClear()
  responseProject = project
  providerResponse = {ollama_running: true, ollama_model_installed: true, ollama_model: 'qwen2.5:7b', openrouter_configured: true, openrouter_model: 'openrouter/free'}
  dictionaryResponse = {configured: false, translations: [], url: 'https://dictionary.cambridge.org/dictionary/english-russian/hello'}
  vi.stubGlobal('fetch', fetchMock)
  URL.createObjectURL = vi.fn(() => 'blob:demo')
  URL.revokeObjectURL = vi.fn()
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('project pages', () => {
  it('opens settings from transcript and downloads SRT', async () => {
    render(<MemoryRouter initialEntries={['/projects/demo/transcript']}><Shell/></MemoryRouter>)
    fireEvent.click(await screen.findByRole('link', {name: 'Проект и экспорт'}))
    expect(await screen.findByText('Выгрузить транскрипцию')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', {name: 'SRT ↓'}))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/projects/demo/export/srt'))
  })

  it('opens settings by its direct URL', async () => {
    render(<MemoryRouter initialEntries={['/projects/demo/settings']}><Shell/></MemoryRouter>)
    expect(await screen.findByText('Выгрузить транскрипцию')).toBeTruthy()
    expect(screen.getByRole('button', {name: 'SRT ↓'}).hasAttribute('disabled')).toBe(false)
  })

  it('opens settings for a project returned by the older backend without title', async () => {
    responseProject = {...project, title: undefined}
    render(<MemoryRouter initialEntries={['/projects/demo/settings']}><Shell/></MemoryRouter>)
    expect(await screen.findByText('Выгрузить транскрипцию')).toBeTruthy()
    expect(screen.getByDisplayValue('demo.mp4')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('Backend запущен со старой версией')
  })

  it('shows the processing page and starts a completed project again', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<MemoryRouter initialEntries={['/processing']}><Shell/></MemoryRouter>)
    expect(await screen.findByText('Запустить или повторить')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', {name: 'Обработать заново'}))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/projects/demo/process', expect.objectContaining({method: 'POST'})))
  })

  it('renames a project from the project list', async () => {
    render(<MemoryRouter initialEntries={['/projects']}><Shell/></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', {name: 'Переименовать'}))
    fireEvent.change(screen.getByRole('textbox', {name: 'Новое название Demo'}), {target: {value: 'Renamed'}})
    fireEvent.click(screen.getByRole('button', {name: 'Сохранить'}))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/projects/demo', expect.objectContaining({method: 'PATCH'})))
  })

  it('opens AI translation and saves context before starting', async () => {
    render(<MemoryRouter initialEntries={['/projects/demo/translation']}><Shell/></MemoryRouter>)
    expect(await screen.findByText('Анализ и перевод')).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox', {name: 'Язык перевода'}), {target: {value: 'Ukrainian'}})
    fireEvent.change(screen.getByRole('textbox', {name: 'Контекст сцены, имена и желаемые термины'}), {target: {value: 'A fantasy story'}})
    fireEvent.click(screen.getByRole('button', {name: 'Анализировать и перевести'}))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/projects/demo/ai/config', expect.objectContaining({method: 'PATCH'})))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/projects/demo/ai/run', expect.objectContaining({method: 'POST'})))
  })

  it('selects configured OpenRouter when the local model is unavailable', async () => {
    providerResponse = {...providerResponse, ollama_running: false, ollama_model_installed: false}
    render(<MemoryRouter initialEntries={['/projects/demo/translation']}><Shell/></MemoryRouter>)
    expect(await screen.findByText('Ключ OpenRouter настроен · openrouter/free')).toBeTruthy()
    expect(screen.getByRole('combobox', {name: 'Модель'})).toHaveProperty('value', 'openrouter')
  })

  it('highlights every translated line even when the model omitted word links', async () => {
    responseProject = {...project, ai_status: 'complete', ai_lines: [
      {id: 'a', segment_ids: ['one'], start: 0, end: 1, speaker_id: 'SPEAKER_00', source_text: 'Hello', translated_text: 'Привет', word_links: []},
      {id: 'b', segment_ids: ['one'], start: 2, end: 3, speaker_id: 'SPEAKER_00', source_text: 'Bye', translated_text: 'Пока', word_links: [{english: 'Bye', russian: 'Пока'}]},
      {id: 'c', segment_ids: ['one'], start: 4, end: 5, speaker_id: 'SPEAKER_00', source_text: 'Thanks', translated_text: 'Спасибо', word_links: []},
    ]}
    render(<MemoryRouter initialEntries={['/projects/demo/translation']}><Shell/></MemoryRouter>)
    fireEvent.mouseEnter(await screen.findByRole('button', {name: 'Hello'}))
    expect(screen.getByText('Привет', {selector: 'mark'})).toBeTruthy()
    fireEvent.mouseEnter(screen.getByRole('button', {name: 'Bye'}))
    expect(screen.getByText('Пока', {selector: 'mark'})).toBeTruthy()
    fireEvent.mouseEnter(screen.getByRole('button', {name: 'Thanks'}))
    expect(screen.getByText('Спасибо', {selector: 'mark'})).toBeTruthy()
  })

  it('shows three Cambridge values and uses a matching value to highlight Russian text', async () => {
    dictionaryResponse = {configured: true, translations: ['Привет', 'Здравствуйте', 'Добрый день'], url: 'https://dictionary.cambridge.org/dictionary/english-russian/hello'}
    responseProject = {...project, ai_status: 'complete', ai_lines: [{id: 'a', segment_ids: ['one'], start: 0, end: 1, speaker_id: 'SPEAKER_00', source_text: 'Hello', translated_text: 'Привет, друг!', word_links: []}]}
    render(<MemoryRouter initialEntries={['/projects/demo/translation']}><Shell/></MemoryRouter>)
    fireEvent.mouseEnter(await screen.findByRole('button', {name: 'Hello'}))
    expect(await screen.findByText('Здравствуйте')).toBeTruthy()
    expect(screen.getByText('Добрый день')).toBeTruthy()
    expect(screen.getByText('Привет', {selector: 'mark'}).className).toBe('')
  })

  it('filters speakers and splits a transcript line at the cursor', async () => {
    responseProject = {...project, segments: [
      {...project.segments[0], text: 'Hello world', end: 2},
      {id: 'two', start: 3, end: 4, text: 'Goodbye', original_text: 'Goodbye', speaker_id: null, words: []},
    ]}
    render(<MemoryRouter initialEntries={['/projects/demo/transcript']}><Shell/></MemoryRouter>)
    const filter = await screen.findByRole('combobox', {name: 'Фильтр говорящих'})
    fireEvent.change(filter, {target: {value: 'SPEAKER_00'}})
    expect(screen.getAllByRole('textbox', {name: /Текст реплики/})).toHaveLength(1)
    expect(screen.getByRole('button', {name: 'Объединить выбранные (0)'}).hasAttribute('disabled')).toBe(true)
    fireEvent.change(filter, {target: {value: 'all'}})
    fireEvent.click(screen.getAllByRole('button', {name: 'Разделить'})[0])
    const input = screen.getAllByRole('textbox', {name: /Текст реплики/})[0] as HTMLTextAreaElement
    input.setSelectionRange(6, 6)
    fireEvent.select(input)
    fireEvent.click(screen.getByRole('button', {name: 'Подтвердить разделение'}))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/projects/demo/segments/one/split', expect.objectContaining({method: 'POST', body: expect.stringContaining('"split_at":6')})))
    fireEvent.click(screen.getByRole('checkbox', {name: 'Выбрать реплику 00:00'}))
    fireEvent.click(screen.getByRole('checkbox', {name: 'Выбрать реплику 00:03'}))
    fireEvent.click(screen.getByRole('button', {name: 'Объединить выбранные (2)'}))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/projects/demo/segments/merge', expect.objectContaining({method: 'POST', body: expect.stringContaining('"segment_ids":["one","two"]')})))
  })

  it('assigns selected lines to an existing speaker without a creation form', async () => {
    responseProject = {...project, speakers: [...project.speakers, {id: 'MANUAL_NEW', name: 'Sam'}], segments: [project.segments[0], {id: 'two', start: 2, end: 3, text: 'Hey', original_text: 'Hey', speaker_id: 'SPEAKER_00', words: []}]}
    render(<MemoryRouter initialEntries={['/projects/demo/transcript']}><Shell/></MemoryRouter>)
    fireEvent.click(await screen.findByRole('checkbox', {name: 'Выбрать реплику 00:00'}))
    fireEvent.click(screen.getByRole('checkbox', {name: 'Выбрать реплику 00:02'}))
    expect((await screen.findByRole('button', {name: 'Назначить говорящего (2)'})).hasAttribute('disabled')).toBe(true)
    expect(screen.queryByRole('textbox', {name: 'Имя нового говорящего в транскрипте'})).toBeNull()
    fireEvent.change(screen.getByRole('combobox', {name: 'Говорящий для назначения'}), {target: {value: 'MANUAL_NEW'}})
    fireEvent.click(screen.getByRole('button', {name: 'Назначить говорящего (2)'}))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/projects/demo/segments/speaker/bulk', expect.objectContaining({method: 'PATCH', body: expect.stringContaining('"speaker_id":"MANUAL_NEW"')})))
    await waitFor(() => expect(screen.getAllByRole('combobox', {name: /Говорящий реплики/}).every(select => (select as HTMLSelectElement).value === 'MANUAL_NEW')).toBe(true))
  })

  it('deletes a speaker from the speakers page and keeps the transcript', async () => {
    render(<MemoryRouter initialEntries={['/projects/demo/speakers']}><Shell/></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', {name: 'Удалить говорящего Alex'}))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/projects/demo/speakers/SPEAKER_00', expect.objectContaining({method: 'DELETE'})))
    await waitFor(() => expect(screen.queryByRole('button', {name: 'Удалить говорящего Alex'})).toBeNull())
    fireEvent.click(screen.getByRole('link', {name: 'Транскрипт'}))
    expect(await screen.findByRole('combobox', {name: 'Говорящий реплики 00:00'})).toHaveProperty('value', '')
  })

  it('does not offer automatic extra speaker retry', async () => {
    render(<MemoryRouter initialEntries={['/projects/demo/speakers']}><Shell/></MemoryRouter>)
    expect(await screen.findByRole('button', {name: 'Обработать заново'})).toBeTruthy()
    expect(screen.queryByRole('button', {name: /Попробовать .* говорящих/})).toBeNull()
  })

  it('opens .env settings and saves a token without displaying it', async () => {
    render(<MemoryRouter initialEntries={['/env']}><Shell/></MemoryRouter>)
    expect(await screen.findByRole('heading', {name: 'Настройки .env'})).toBeTruthy()
    const token = await screen.findByLabelText('Новый токен') as HTMLInputElement
    fireEvent.change(token, {target: {value: 'hf_test_secret'}})
    fireEvent.click(screen.getByRole('button', {name: 'Сохранить токен'}))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/settings/env', expect.objectContaining({method: 'PATCH', body: expect.stringContaining('"key":"HF_TOKEN"')})))
    await waitFor(() => expect(token.value).toBe(''))
    expect(screen.queryByText('hf_test_secret')).toBeNull()
  })

  it('saves Cambridge API access key from the env page', async () => {
    render(<MemoryRouter initialEntries={['/env']}><Shell/></MemoryRouter>)
    const input = await screen.findByLabelText('Ключ Cambridge API') as HTMLInputElement
    fireEvent.change(input, {target: {value: 'cambridge_test_key'}})
    fireEvent.click(screen.getByRole('button', {name: 'Сохранить ключ'}))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/settings/env', expect.objectContaining({method: 'PATCH', body: expect.stringContaining('"key":"CAMBRIDGE_API_KEY"')})))
    expect(input.value).toBe('')
  })
})
