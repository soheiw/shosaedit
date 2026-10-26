const countLimit = 2147483647;
const sides = [['R', 9], ['L', 8]];
const fail = (code, message) => { throw Object.assign(new Error(message), {code}); };

// Compose raw motor counts. No joint offsets, mirrored-arm signs or angle wraps
// belong here: recorded integer counts must survive each retained frame exactly.
export function composeSequence(segments, {name = 'Sequence', maxFrames = 10000} = {}) {
  if (!Number.isInteger(maxFrames) || maxFrames < 2 || maxFrames > 10000)
    fail('INVALID_BUDGET', 'Maximum frame count must be an integer between 2 and 10000.');
  if (!Array.isArray(segments) || segments.length === 0)
    fail('EMPTY_SEQUENCE', 'Select at least one motion segment.');
  if (segments.length > maxFrames) fail('TOO_LONG', 'Too many motion segments.');
  const selections = Array.from(segments).map((segment, index) => {
    if (!segment || typeof segment !== 'object') fail('INVALID_SEGMENT', 'Invalid motion segment.');
    const clip = segment.clip;
    for (const [side, columns] of sides) {
      const rows = clip?.[side];
      if (!Array.isArray(rows) || rows.length < 1 || rows.length > 10000 ||
          !Array.from(rows).every(row => Array.isArray(row) && row.length === columns &&
            Array.from(row).every(value => Number.isSafeInteger(value) && Math.abs(value) <= countLimit)))
        fail('INVALID_DATA', 'Motion data requires 9 right and 8 left safe integer columns.');
    }
    const length = Math.max(clip.R.length, clip.L.length);
    const {startFrame = 0, endFrame = length} = segment;
    const transitionMode = index === segments.length - 1 ? 'insert' : (segment.transitionMode === undefined ? 'insert' : segment.transitionMode);
    if (!['insert', 'overlap'].includes(transitionMode)) fail('INVALID_TRANSITION', 'Unknown transition mode.');
    const transitionFrames = index === segments.length - 1 ? 0 : (segment.transitionFrames === undefined ? 15 : segment.transitionFrames);
    if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame) ||
        startFrame < 0 || endFrame <= startFrame || endFrame > length)
      fail('INVALID_TRIM', 'Invalid trim range.');
    if (!Number.isInteger(transitionFrames) || transitionFrames < 0 || transitionFrames > 300)
      fail('INVALID_TRANSITION', 'Transition frames must be an integer between 0 and 300.');
    return {clip, startFrame, endFrame, transitionFrames, transitionMode};
  });
  // Footprints may overlap. All end indices are exclusive, including joins.
  let cursor = 0;
  const metadata = selections.map((s, index) => {
    const length = s.endFrame - s.startFrame;
    const incoming = index && selections[index - 1].transitionMode === 'overlap' ? selections[index - 1].transitionFrames : 0;
    const outgoing = s.transitionMode === 'overlap' ? s.transitionFrames : 0;
    if (outgoing === 1 || outgoing > length || (outgoing && outgoing > selections[index + 1].endFrame - selections[index + 1].startFrame))
      fail('INVALID_OVERLAP', 'Overlap must be zero or at least two frames, and fit both adjacent selections.');
    if (incoming + outgoing > length)
      fail('OVERLAP_CONFLICT', 'Incoming and outgoing overlaps cannot consume the same source frames.');
    const outputStartFrame = cursor, outputEndFrame = cursor + length;
    const joinStartFrame = outputEndFrame - outgoing;
    const joinEndFrame = joinStartFrame + s.transitionFrames;
    cursor = s.transitionMode === 'overlap' ? joinStartFrame : joinEndFrame;
    return {startFrame: s.startFrame, endFrame: s.endFrame, transitionFrames: s.transitionFrames,
      transitionMode: s.transitionMode, outputStartFrame, outputEndFrame, joinStartFrame, joinEndFrame};
  });
  const last = metadata[metadata.length - 1];
  const frameCount = last.outputEndFrame;
  if (frameCount < 2) fail('TOO_SHORT', 'A sequence must contain at least 2 frames.');
  if (frameCount > maxFrames) fail('TOO_LONG', `Sequence exceeds ${maxFrames} frames.`);
  const result = {format: 'augmented-arms-motion', version: 1, fps: 30,
    name: String(name || 'Sequence').slice(0, 100), exportStem: 'Sequence',
    description: '複数の動作を切り出し、接続区間を補間した動き', bakedEdits: true,
    R: [], L: [], composition: {fps: 30, interpolation: 'quintic-smoothstep', segments: metadata}};
  const sample = (clip, side, frame) => clip[side][Math.min(frame, clip[side].length - 1)];
  for (let index = 0; index < selections.length; index++) {
    const {clip, startFrame, endFrame, transitionFrames, transitionMode} = selections[index];
    const incoming = index && selections[index - 1].transitionMode === 'overlap' ? selections[index - 1].transitionFrames : 0;
    const outgoing = transitionMode === 'overlap' ? transitionFrames : 0;
    for (let frame = startFrame + incoming; frame < endFrame - outgoing; frame++)
      for (const [side] of sides) result[side].push([...sample(clip, side, frame)]);
    if (!transitionFrames) continue;
    const next = selections[index + 1];
    for (let frame = 0; frame < transitionFrames; frame++) {
      // Overlap follows both moving tracks, preserving their endpoint
      // derivatives in continuous time. It does not align phase/calibration
      // or guarantee low velocity/acceleration for mismatched source tracks.
      const u = transitionMode === 'overlap' ? frame / (transitionFrames - 1) : (frame + 1) / (transitionFrames + 1);
      const weight = u * u * u * (10 + u * (-15 + 6 * u));
      for (const [side] of sides) {
        const a = sample(clip, side, transitionMode === 'overlap' ? endFrame - transitionFrames + frame : endFrame - 1);
        const b = sample(next.clip, side, transitionMode === 'overlap' ? next.startFrame + frame : next.startFrame);
        result[side].push(a.map((value, column) => Math.round(value + (b[column] - value) * weight)));
      }
    }
  }
  return result;
}
