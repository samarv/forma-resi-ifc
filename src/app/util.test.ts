import test from 'node:test';
import assert from 'node:assert/strict';
import {
  areaIn, areaOut, clamp, compact, esc, fmtBytes, fmtLenPlain, fmtMs, humanize, lenIn, lenOut, n3, slotFor,
} from './util.ts';

test('n3 rounds to 3 decimals and never emits -0', () => {
  assert.equal(n3(1.23456), '1.235');
  assert.equal(n3(-0.0001), '0');
  assert.equal(n3(0), '0');
  assert.equal(n3(12), '12');
  assert.equal(n3(Number.NaN), '0');
});

test('esc escapes every html-significant character', () => {
  assert.equal(esc('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.equal(esc(undefined), '');
});

test('humanize turns ids into sentence case', () => {
  assert.equal(humanize('corridor-midrise'), 'Corridor midrise');
  assert.equal(humanize('living-kitchen'), 'Living kitchen');
  assert.equal(humanize(''), '');
});

test('length display conversion round-trips', () => {
  for (const m of [0.1, 1, 2.75, 12.5, 78]) {
    assert.ok(Math.abs(lenOut(lenIn(m, 'metric'), 'metric') - m) < 1e-6, `metric ${m}`);
    assert.ok(Math.abs(lenOut(lenIn(m, 'imperial', 4), 'imperial') - m) < 1e-4, `imperial ${m}`);
  }
  assert.equal(lenIn(1, 'imperial', 2), 3.28);
  assert.equal(fmtLenPlain(1, 'imperial', 1), '3.3 ft');
  assert.equal(fmtLenPlain(1.5, 'metric', 2), '1.50 m');
});

test('area display conversion round-trips within rounding', () => {
  const m2 = 52.3;
  assert.ok(Math.abs(areaOut(areaIn(m2, 'imperial'), 'imperial') - m2) < 0.2);
  assert.equal(areaIn(52.34, 'metric'), 52.3);
});

test('compact and byte/ms formatting', () => {
  assert.equal(compact(1284), '1,284');
  assert.equal(compact(12900), '12.9K');
  assert.equal(compact(4.2e6), '4.2M');
  assert.equal(fmtBytes(0), '—');
  assert.equal(fmtBytes(512), '512 B');
  assert.equal(fmtBytes(2048), '2.0 kB');
  assert.equal(fmtBytes(5 * 1024 * 1024), '5.00 MB');
  assert.equal(fmtMs(12.4), '12 ms');
  assert.equal(fmtMs(2500), '2.50 s');
});

test('clamp and slot assignment are stable', () => {
  assert.equal(clamp(12, 1, 8), 8);
  assert.equal(clamp(-2, 1, 8), 1);
  const a = slotFor('2b2b');
  assert.equal(a, slotFor('2b2b'));
  assert.ok(a >= 1 && a <= 8);
});
