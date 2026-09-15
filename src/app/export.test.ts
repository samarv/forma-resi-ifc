import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS } from '../core/spec.ts';
import { buildMockModel, mockWriteIfc } from './mock-model.ts';
import { buildReport, safeFileName, specFromLoaded } from './export.ts';

test('safeFileName strips anything a filesystem would object to', () => {
  assert.equal(safeFileName('Riverside Commons'), 'Riverside-Commons');
  assert.equal(safeFileName('  a/b\\c:d*e  '), 'a-b-c-d-e');
  assert.equal(safeFileName(''), 'building');
  assert.equal(safeFileName('---'), 'building');
  assert.ok(safeFileName('x'.repeat(200)).length <= 80);
});

test('buildReport summarises the model', () => {
  const model = buildMockModel(PRESETS[0].spec);
  const ifc = mockWriteIfc(model);
  const r = buildReport(model, ifc, 'mock');
  assert.equal(r.backend, 'mock');
  assert.equal(r.elements.total, model.elements.length);
  assert.equal(Object.values(r.elements.byDiscipline).reduce((a, b) => a + b, 0), model.elements.length);
  assert.equal(Object.values(r.elements.byIfcType).reduce((a, b) => a + b, 0), model.elements.length);
  assert.equal(r.ifc?.entityCount, ifc.entityCount);
  assert.equal(r.metrics.length, model.metrics.length);
  assert.equal(r.patterns.applications, model.patterns.applications.length);
  assert.equal(r.storeys.length, model.storeys.length);
  assert.ok(r.spec.typology);
  // must survive a JSON round-trip (it is written to a file)
  const back = JSON.parse(JSON.stringify(r));
  assert.equal(back.elements.total, r.elements.total);
});

test('buildReport tolerates a missing IFC', () => {
  const model = buildMockModel(PRESETS[1].spec);
  const r = buildReport(model, null, 'mock');
  assert.equal(r.ifc, null);
});

test('specFromLoaded accepts a bare spec or a report', () => {
  const spec = { typology: 'corridor-midrise', massing: { storeys: 5 } };
  assert.deepEqual(specFromLoaded(spec), spec);
  assert.deepEqual(specFromLoaded({ spec, generatedAt: 'x' }), spec);
  assert.throws(() => specFromLoaded({ nope: 1 }), /No spec found/);
  assert.throws(() => specFromLoaded(null), /No spec found/);
  assert.throws(() => specFromLoaded('string'), /No spec found/);
});
