// Work on export copies. Keep the recording clock, and match both endpoints
// to the explicitly calibrated rest pose, in the existing frames.
export function bindReferenceEnds(recording) {
  for (const side of ['R', 'L']) {
    const rows = recording[side];
    const rest = recording.calibrationSnapshot?.[side]?.rest;
    if (!rows?.length || !Array.isArray(rest) || rest.length !== rows[0].length)
      throw Error('基準点を設定してください / Set the model reference pose');
    const last = rows.length - 1;
    const window = Math.min(30, Math.floor(last / 2));
    const ends = [rows[0], rows[last]];
    if (ends.every(row => row.every((v, j) => v === rest[j]))) continue;
    if (window < 1) throw Error('基準点への移行には3フレーム以上必要です');
    recording[side] = rows.map((row, i) => {
      const distance = Math.min(i, last - i);
      if (distance >= window) return row.slice();
      const u = distance / window;
      const weight = u ** 3 * (10 - 15 * u + 6 * u * u);
      return row.map((v,j) => Math.round(rest[j] + weight * (v - rest[j])));
    });
  }
  return recording;
}
