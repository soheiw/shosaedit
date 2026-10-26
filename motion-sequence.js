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
    const transitionFrames = index === segments.length - 1 ? 0 : (segment.transitionFrames === undefined ? 15 : segment.transitionFrames);
    if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame) ||
        startFrame < 0 || endFrame <= startFrame || endFrame > length)
      fail('INVALID_TRIM', 'Invalid trim range.');
    if (!Number.isInteger(transitionFrames) || transitionFrames < 0 || transitionFrames > 300)
      fail('INVALID_TRANSITION', 'Transition frames must be an integer between 0 and 300.');
    return {clip, startFrame, endFrame, transitionFrames};
  });
  const frameCount = selections.reduce((total, s) => total + s.endFrame - s.startFrame + s.transitionFrames, 0);
  if (frameCount < 2) fail('TOO_SHORT', 'A sequence must contain at least 2 frames.');
  if (frameCount > maxFrames) fail('TOO_LONG', `Sequence exceeds ${maxFrames} frames.`);
  const result = {format: 'augmented-arms-motion', version: 1, fps: 30,
    name: String(name || 'Sequence').slice(0, 100), exportStem: 'Sequence',
    description: '複数の動作を切り出し、接続区間を補間した動き', bakedEdits: true,
    R: [], L: [], composition: {fps: 30, interpolation: 'quintic-smoothstep', segments: []}};
  const sample = (clip, side, frame) => clip[side][Math.min(frame, clip[side].length - 1)];
  for (let index = 0; index < selections.length; index++) {
    const selection = selections[index];
    const {clip, startFrame, endFrame, transitionFrames} = selection;
    result.composition.segments.push({startFrame, endFrame, transitionFrames,
      outputStartFrame: result.R.length, outputEndFrame: result.R.length + endFrame - startFrame});
    for (let frame = startFrame; frame < endFrame; frame++)
      for (const [side] of sides) result[side].push([...sample(clip, side, frame)]);
    if (!transitionFrames) continue;
    const next = selections[index + 1];
    for (let frame = 1; frame <= transitionFrames; frame++) {
      const u = frame / (transitionFrames + 1);
      const weight = u * u * u * (10 + u * (-15 + 6 * u));
      for (const [side] of sides) {
        const a = sample(clip, side, endFrame - 1), b = sample(next.clip, side, next.startFrame);
        result[side].push(a.map((value, column) => Math.round(value + (b[column] - value) * weight)));
      }
    }
  }
  return result;
}
