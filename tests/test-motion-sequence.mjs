import assert from 'node:assert/strict';
import {composeSequence} from '../motion-sequence.js';
import {validateRecording} from '../motion-files.js';

const row = (count, columns) => Array.from({length: columns}, (_, i) => count + i * 7);
const clip = (countsR, countsL = countsR) => ({R: countsR.map(v => row(v, 9)), L: countsL.map(v => row(v, 8))});
const a = clip([10, 20, 30, 40], [-100, -90]), b = clip([500, 600, 700], [1000, 1100, 1200]);
const before = JSON.stringify([a, b]);
const sequence = composeSequence([
  {clip: a, startFrame: 1, endFrame: 4, transitionFrames: 3},
  {clip: b, startFrame: 1, endFrame: 3, transitionFrames: 300}
], {name: 'Custom sequence'});
assert.equal(sequence.R.length, 8);
assert.equal(sequence.L.length, 8);
assert.equal(sequence.name, 'Custom sequence');
assert.deepEqual(sequence.R.slice(0, 3), a.R.slice(1));
assert.deepEqual(sequence.L.slice(0, 3), [a.L[1], a.L[1], a.L[1]]);
assert.deepEqual(sequence.R.slice(-2), b.R.slice(1));
assert.deepEqual(sequence.L.slice(-2), b.L.slice(1));
assert.deepEqual(sequence.composition.segments.map(s => [s.outputStartFrame, s.outputEndFrame, s.transitionFrames]), [[0, 3, 3], [6, 8, 0]]);
for (const side of ['R', 'L']) {
  const last = sequence[side][2], first = sequence[side][6];
  for (let k = 1; k <= 3; k++) {
    const u = k / 4, w = 6 * u ** 5 - 15 * u ** 4 + 10 * u ** 3;
    sequence[side][k + 2].forEach((value, column) => {
      assert.equal(value, Math.round(last[column] + (first[column] - last[column]) * w));
      assert.ok(value >= Math.min(last[column], first[column]) && value <= Math.max(last[column], first[column]));
    });
  }
}
assert.equal(JSON.stringify([a, b]), before);
sequence.R[0][0] = 999;
assert.equal(a.R[1][0], 20, 'retained rows must be copied');
assert.equal(validateRecording(sequence).R.length, 8);

const direct = composeSequence([{clip: a, transitionFrames: 0}, {clip: b}]);
assert.deepEqual(direct.R, [...a.R, ...b.R]);
assert.deepEqual(direct.L, [...a.L, a.L[1], a.L[1], ...b.L]);
const unchanged = composeSequence([{clip: a, startFrame: 3, endFrame: 4, transitionFrames: 10}, {clip: a, startFrame: 3, endFrame: 4}]);
assert.ok(unchanged.R.every(r => r.every((v, c) => v === a.R[3][c])));
assert.ok(unchanged.L.every(r => r.every((v, c) => v === a.L[1][c])));

// Crossing the usual angle-period boundary must interpolate raw counts rather
// than take a wrapped short path; finger columns follow the very same rule.
const extreme = composeSequence([{clip: clip([4090]), transitionFrames: 1}, {clip: clip([10])}]);
assert.deepEqual(extreme.R[1], row(2050, 9));
assert.deepEqual(extreme.L[1], row(2050, 8));
const signed = composeSequence([{clip: {R: [Array(9).fill(-2147483647)], L: [Array(8).fill(2147483647)]}, transitionFrames: 1},
  {clip: {R: [Array(9).fill(2147483647)], L: [Array(8).fill(-2147483647)]}}]);
assert.ok(signed.R[1].every(v => v === 0));
assert.ok(signed.L[1].every(v => v === 0));
validateRecording(signed);

assert.throws(() => composeSequence([]), {code: 'EMPTY_SEQUENCE'});
assert.equal(composeSequence([{clip: a, transitionFrames: -500}]).R.length, 4, 'last outgoing edge is ignored');
assert.throws(() => composeSequence(null));
for (const invalid of [null, {}, {R: [], L: []}, {R: [[1]], L: [row(0, 8)]}, {R: Array(2), L: [row(0, 8)]}, {R: [Array(9)], L: [row(0, 8)]}, clip([NaN]), clip([1.5]), clip([2147483648])])
  assert.throws(() => composeSequence([{clip: invalid}]));
for (const range of [{startFrame: -1}, {startFrame: 2, endFrame: 2}, {endFrame: 5}, {startFrame: 0.5}, {endFrame: NaN}])
  assert.throws(() => composeSequence([{clip: a, ...range}]));
for (const frames of [-1, 301, 1.5, NaN, null])
  assert.throws(() => composeSequence([{clip: a, transitionFrames: frames}, {clip: b}]), {code: 'INVALID_TRANSITION'});
for (const maxFrames of [1, 10001, NaN, 3.5])
  assert.throws(() => composeSequence([{clip: a}], {maxFrames}));
assert.throws(() => composeSequence([{clip: a, transitionFrames: 3}, {clip: b}], {maxFrames: 9}));
assert.throws(() => composeSequence([{clip: a, startFrame: 0, endFrame: 1}]));
assert.equal(composeSequence([{clip: a}], {maxFrames: 4}).R.length, 4);
const budgetClip = clip(Array(10000).fill(100));
assert.equal(composeSequence([{clip: budgetClip}]).R.length, 10000);
assert.throws(() => composeSequence([{clip: budgetClip, transitionFrames: 0}, {clip: a}]));
console.log('Motion sequence: trimming, all motor channels, unequal arms, smooth transitions, source immutability and limits passed.');
