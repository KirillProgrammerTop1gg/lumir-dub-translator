import { useOutletContext } from 'react-router-dom'
import { TranscriptPanel } from '../components/TranscriptPanel'
import type { ProjectActions } from '../components/ProjectWorkspace'

export function TranscriptPage() {
  const actions = useOutletContext<ProjectActions>()
  return <TranscriptPanel project={actions.project} device={actions.device} setDevice={actions.setDevice} expectedSpeakers={actions.expectedSpeakers} setExpectedSpeakers={actions.setExpectedSpeakers} busy={actions.busy} onProcess={actions.process} onSaveSegment={actions.saveSegment} onMergeSegments={actions.mergeSegments} onAssignSpeaker={actions.assignSpeaker} onSplitSegment={actions.splitSegment} onError={actions.onError}/>
}
