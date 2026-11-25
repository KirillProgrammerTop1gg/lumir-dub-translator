import { describe, expect, it } from 'vitest'
import { englishDialogue, type Project } from './lib'

describe('english dialogue export', () => {
  it('joins adjacent lines with the same visible name even across speaker IDs', () => {
    const project = {
      speakers: [{id: 'A1', name: 'Quinn'}, {id: 'A2', name: 'Quinn'}, {id: 'B1', name: 'Rue'}, {id: 'B2', name: 'Rue'}],
      segments: [
        {id: '1', text: "I'm just laying the breadcrumbs for when we make it big.", speaker_id: 'A1'},
        {id: '2', text: "Isn't that right, Rue?", speaker_id: 'A2'},
        {id: '3', text: 'Uh, yeah, of course.', speaker_id: 'B1'},
        {id: '4', text: 'Everyone loves a good origin story, right?', speaker_id: 'B2'},
      ],
    } as Project
    expect(englishDialogue(project)).toBe("Quinn — I'm just laying the breadcrumbs for when we make it big. Isn't that right, Rue?\nRue — Uh, yeah, of course. Everyone loves a good origin story, right?\n")
  })
})
