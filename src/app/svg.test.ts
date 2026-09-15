import test from 'node:test';
import assert from 'node:assert/strict';
import type { Vec2 } from '../core/types.ts';
import { bboxOf, boxQuad, circlePath, linePath, padRect, pathEl, polyPath, rectPath, unionRect, wallQuad, text } from './svg.ts';

test('polyPath negates Y so +Y draws upward', () => {
  assert.equal(polyPath([[0, 0], [2, 0], [2, 3]]), 'M0 0L2 0L2 -3Z');
  assert.equal(polyPath([[0, 0], [2, 0]], false), 'M0 0L2 0');
  assert.equal(polyPath([]), '');
});

test('rectPath walks the rectangle counter-clockwise in world space', () => {
  assert.equal(rectPath({ x: 1, y: 2, w: 3, h: 4 }), 'M1 -2L4 -2L4 -6L1 -6Z');
});

test('wallQuad centres the thickness on the centreline', () => {
  const q = wallQuad([0, 0], [4, 0], 0.3);
  assert.deepEqual(q, [[0, 0.15], [4, 0.15], [4, -0.15], [0, -0.15]]);
  const v = wallQuad([0, 0], [0, 4], 0.2);
  assert.deepEqual(v.map((p) => p.map((n) => Math.round(n * 1000) / 1000)), [[-0.1, 0], [-0.1, 4], [0.1, 4], [0.1, 0]]);
  // degenerate wall must not produce NaN
  assert.ok(wallQuad([1, 1], [1, 1], 0.2).every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])));
});

test('boxQuad rotates about the min corner', () => {
  const q = boxQuad(1, 1, 2, 1, Math.PI / 2).map((p) => p.map((n) => Math.round(n * 1000) / 1000) as Vec2);
  assert.deepEqual(q, [[1, 1], [1, 3], [0, 3], [0, 1]]);
});

test('linePath, circlePath and text emit finite coordinates', () => {
  assert.equal(linePath([0, 1], [2, 3]), 'M0 -1L2 -3');
  assert.ok(!circlePath(1, 2, 0.5).includes('NaN'));
  assert.ok(text(1, 2, 'Bed & bath').includes('Bed &amp; bath'));
  assert.ok(text(1, 2, 'x', { size: 0.4 }).includes('y="-2"'));
});

test('bbox helpers', () => {
  assert.deepEqual(bboxOf([[0, 0], [2, 5]]), { x: 0, y: 0, w: 2, h: 5 });
  assert.deepEqual(padRect({ x: 0, y: 0, w: 2, h: 2 }, 1), { x: -1, y: -1, w: 4, h: 4 });
  assert.deepEqual(unionRect({ x: 0, y: 0, w: 1, h: 1 }, { x: 2, y: 2, w: 1, h: 1 }), { x: 0, y: 0, w: 3, h: 3 });
  assert.deepEqual(unionRect(null, { x: 1, y: 1, w: 1, h: 1 }), { x: 1, y: 1, w: 1, h: 1 });
  // empty point list must not yield NaN bounds
  const b = bboxOf([]);
  assert.ok(Number.isFinite(b.w) && b.w > 0);
});

test('pathEl skips empty geometry and drops undefined attributes', () => {
  assert.equal(pathEl('', { fill: 'red' }), '');
  assert.equal(pathEl('M0 0', { fill: 'red', stroke: undefined, 'stroke-width': 2 }), '<path d="M0 0" fill="red" stroke-width="2"/>');
});
