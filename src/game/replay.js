// OWNER: Match flow & replay agent. STUB.
// createReplayBuffer(seconds) -> { record(frame), startPlayback(seconds) -> Playback|null, clear() }
// Playback: { update(frameDt) -> { view, cameraHint:{ mode:'follow'|'wide'|'ball'|'goal', targetCarId } } | null when finished, skip() }
export function createReplayBuffer() {
  return { record() {}, startPlayback() { return null; }, clear() {} };
}
