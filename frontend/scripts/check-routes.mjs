import assert from 'node:assert/strict'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { createServer } from 'vite'

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' })
try {
  const { ProjectWorkspace } = await vite.ssrLoadModule('/src/components/ProjectWorkspace.tsx')
  const { SettingsPage } = await vite.ssrLoadModule('/src/pages/SettingsPage.tsx')
  const { SpeakersPage } = await vite.ssrLoadModule('/src/pages/SpeakersPage.tsx')
  const { TranscriptPage } = await vite.ssrLoadModule('/src/pages/TranscriptPage.tsx')
  const { TranslationPage } = await vite.ssrLoadModule('/src/pages/TranslationPage.tsx')
  const { EnvSettingsPage } = await vite.ssrLoadModule('/src/pages/EnvSettingsPage.tsx')
  const project = { id: 'demo', filename: 'demo.mp4', title: 'Demo', duration: 30, status: 'complete', stage: 'complete', progress: 100, device: 'cpu', expected_speakers: 2, error: null, speakers: [], segments: [{id: 'one', start: 0, end: 1, text: 'Hello', original_text: 'Hello', speaker_id: null, words: []}], context_notes: '', target_language: 'Russian', ai_status: 'idle', ai_error: null, ai_progress: 0, ai_lines: [] }
  for (const [path, Page, marker] of [['settings', SettingsPage, 'Выгрузить транскрипцию'], ['speakers', SpeakersPage, 'Говорящие в видео'], ['transcript', TranscriptPage, 'Реплики'], ['translation', TranslationPage, 'Анализ и перевод']]) {
    const html = renderToString(React.createElement(MemoryRouter, {initialEntries: [`/projects/demo/${path}`]}, React.createElement(Routes, null, React.createElement(Route, {path: '/projects/:projectId', element: React.createElement(ProjectWorkspace, {project, onChange() {}, onDeleted() {}, onError() {}})}, React.createElement(Route, {path, element: React.createElement(Page)})))))
    assert.ok(html.includes(marker), `${path} page did not render`)
    assert.ok(html.includes(`href="/projects/demo/${path}"`), `${path} navigation link is missing`)
    if (path === 'settings') assert.ok(html.includes('class="export-link">SRT'), 'SRT export button is disabled')
  }
  const envHtml = renderToString(React.createElement(MemoryRouter, {initialEntries: ['/env']}, React.createElement(Routes, null, React.createElement(Route, {path: '/env', element: React.createElement(EnvSettingsPage)}))))
  assert.ok(envHtml.includes('Настройки .env'), '.env settings page did not render')
  console.log('Routes render correctly')
} finally {
  await vite.close()
}
