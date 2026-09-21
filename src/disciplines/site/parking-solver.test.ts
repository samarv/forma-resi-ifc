/**
 * SIT-07 parking solver: the single capacity function, the pure unit estimate, the level
 * resolutions (add-basement-level / add-podium-level / relax-parking-ratio) and the write-back
 * into the storey stack.
 *
 * Run: node --test src/disciplines/site/parking-solver.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { BuildingSpec, Rect } from '../../core/types.ts';
import { PRESETS, normalizeSpec, type PartialSpec } from '../../core/spec.ts';
import { getTypology } from '../../core/typologies.ts';
import { createRng } from '../../core/rng.ts';
import { IdFactory } from '../../core/ids.ts';
import { generateSite } from './index.ts';
import { resolveFrame, buildMassing } from './massing.ts';
import { issueSink, nullSink } from './issues.ts';
import {
  accessibleFor, applyParkingPlan, estimateUnits, evEveryFor, parkingFloors, rampRect, solveParking,
  stallCapacity, stallSlots, structuredZone,
} from './parking-solver.ts';

function framed(partial: PartialSpec): { spec: BuildingSpec; typology: ReturnType<typeof getTypology>; frame: ReturnType<typeof resolveFrame> } {
  const spec = normalizeSpec(partial);
  const typology = getTypology(spec.typology);
  return { spec, typology, frame: resolveFrame(spec, typology, nullSink(), []) };
}

// ---------------------------------------------------------------------------
// stallCapacity — the one capacity function
// ---------------------------------------------------------------------------

test('stallCapacity counts exactly the slots stallSlots emits', () => {
  const zones: Rect[] = [
    { x: 0, y: 0, w: 41.2, h: 39.2 }, { x: 5, y: 5, w: 18, h: 12 }, { x: 0, y: 0, w: 60, h: 17 },
    { x: 0, y: 0, w: 2, h: 2 }, { x: 0, y: 0, w: 12, h: 60 },
  ];
  for (const z of zones) {
    for (const accessible of [0, 4]) {
      const opts = { accessible, evEvery: 5 };
      assert.equal(stallCapacity(z, opts), stallSlots(z, opts).slots.length, `${z.w}×${z.h} acc=${accessible}`);
    }
  }
});

test('a zone too small for a stall row plus an aisle holds nothing', () => {
  assert.equal(stallCapacity({ x: 0, y: 0, w: 30, h: 10 }), 0, '10 m is below 5.4 + 6.0');
  assert.equal(stallCapacity({ x: 0, y: 0, w: 1, h: 30 }), 0);
  assert.equal(stallCapacity({ x: 0, y: 0, w: 0, h: 0 }), 0);
});

test('capacity grows with the plate, accessible stalls cost capacity, a ramp costs capacity', () => {
  const small: Rect = { x: 0, y: 0, w: 30, h: 20 };
  const big: Rect = { x: 0, y: 0, w: 60, h: 40 };
  assert.ok(stallCapacity(big) > stallCapacity(small));
  assert.ok(stallCapacity(big, { accessible: 10 }) < stallCapacity(big));
  const ramp = rampRect(big);
  assert.ok(stallCapacity(big, { exclude: ramp }) < stallCapacity(big), 'the ramp must displace stalls');
  // the pre-massing area allowance is within a couple of stalls of the exact ramp exclusion
  const exact = stallCapacity(big, { exclude: ramp });
  const approx = stallCapacity(big, { rampAllowance: 3.5 * 12 });
  assert.ok(Math.abs(exact - approx) <= 4, `ramp allowance ${approx} vs exact ${exact}`);
});

test('every stall is inside its zone, disjoint, and typed', () => {
  const zone: Rect = { x: 3, y: 7, w: 41.2, h: 39.2 };
  const { slots } = stallSlots(zone, { accessible: 3, evEvery: 5 });
  assert.ok(slots.length > 20);
  for (const s of slots) {
    assert.ok(s.rect.x >= zone.x - 1e-9 && s.rect.x + s.rect.w <= zone.x + zone.w + 1e-9, 'stall outside the zone in x');
    assert.ok(s.rect.y >= zone.y - 1e-9 && s.rect.y + s.rect.h <= zone.y + zone.h + 1e-9, 'stall outside the zone in y');
  }
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      const a = slots[i].rect, b = slots[j].rect;
      const overlap = a.x < b.x + b.w - 1e-9 && b.x < a.x + a.w - 1e-9 && a.y < b.y + b.h - 1e-9 && b.y < a.y + a.h - 1e-9;
      assert.equal(overlap, false, 'two stalls overlap');
    }
  }
  assert.equal(slots.filter(s => s.type === 'accessible').length, 3);
  assert.ok(slots.some(s => s.type === 'ev'));
  assert.equal(accessibleFor(100), 5);
  assert.equal(evEveryFor(0.2), 5);
  assert.equal(evEveryFor(0), 0);
});

// ---------------------------------------------------------------------------
// estimateUnits — pure, and in step with the massing
// ---------------------------------------------------------------------------

test('estimateUnits agrees with the massing unit estimate within ±2 on every preset', () => {
  for (const preset of PRESETS) {
    const { spec, typology, frame } = framed(preset.spec);
    // the site model resolves the parking levels first, exactly as the pipeline does
    const site = generateSite(spec, typology, createRng(spec.seed).fork('site'), []);
    const est = estimateUnits(spec, typology, frame);
    const built = site.derived.estimatedUnits;
    assert.ok(Math.abs(est - built) <= 2, `${preset.id}: estimateUnits ${est} vs massing ${built}`);
  }
});

test('estimateUnits needs no bars and does not disturb the rng stream', () => {
  const { spec, typology, frame } = framed(PRESETS[0].spec);
  const a = estimateUnits(spec, typology, frame);
  const b = estimateUnits(spec, typology, frame);
  assert.equal(a, b);
  const rngA = createRng(7).fork('massing');
  const massA = buildMassing(spec, typology, frame, rngA, new IdFactory('site'), nullSink(), []);
  estimateUnits(spec, typology, frame);
  const rngB = createRng(7).fork('massing');
  const massB = buildMassing(spec, typology, frame, rngB, new IdFactory('site'), nullSink(), []);
  assert.equal(JSON.stringify(massA.massing.bars), JSON.stringify(massB.massing.bars));
});

// ---------------------------------------------------------------------------
// The solve
// ---------------------------------------------------------------------------

test('a point tower on a retail podium gets a second basement instead of a shortfall warning', () => {
  const { spec, typology, frame } = framed(PRESETS.find(p => p.id === 'ca-point-tower')!.spec);
  const sink = issueSink();
  const units = estimateUnits(spec, typology, frame);
  const plan = solveParking({ spec, typology, frame, estimatedUnits: units, sink });
  assert.equal(plan.basementStoreys, 2, 'B2 was not added');
  assert.ok(plan.achieved >= plan.required, `achieved ${plan.achieved} < required ${plan.required}`);
  assert.equal(plan.ratioApplied, plan.ratioRequested);
  const added = sink.all().filter(i => i.resolution?.id === 'add-basement-level');
  assert.equal(added.length, 1);
  assert.equal(added[0].severity, 'info');
  assert.equal(added[0].storey, 'B2');
  assert.deepEqual(sink.all().filter(i => i.severity === 'deviation'), []);
});

test('the basement count is capped, and the shortfall becomes a relax-parking-ratio deviation', () => {
  const { spec, typology, frame } = framed({
    typology: 'courtyard-block', seed: 5, region: 'IE',
    site: { width: 40, depth: 34, context: 'urban', parking: { type: 'underground', ratio: 3 } },
    massing: { storeys: 8, footprintShape: 'bar', roof: 'flat', maxBasementStoreys: 2 },
  });
  const sink = issueSink();
  const plan = solveParking({ spec, typology, frame, estimatedUnits: estimateUnits(spec, typology, frame), sink });
  assert.equal(plan.basementStoreys, 2, 'must stop at maxBasementStoreys');
  assert.ok(plan.achieved < plan.required);
  assert.ok(plan.ratioApplied < plan.ratioRequested);
  const relax = sink.all().filter(i => i.resolution?.id === 'relax-parking-ratio');
  assert.equal(relax.length, 1);
  assert.equal(relax[0].severity, 'deviation');
  assert.equal(relax[0].limit, plan.required);
  assert.equal(relax[0].observed, plan.achieved);
});

test('podium levels are added only when podiumUse is parking', () => {
  const base: PartialSpec = {
    typology: 'corridor-midrise', seed: 7, region: 'US',
    site: { width: 78, depth: 42, context: 'urban', parking: { type: 'podium', ratio: 2.5 } },
    massing: { storeys: 8, podiumStoreys: 1, podiumUse: 'parking', footprintShape: 'bar', roof: 'flat' },
  };
  const parkingPodium = framed(base);
  const sinkA = issueSink();
  const planA = solveParking({
    spec: parkingPodium.spec, typology: parkingPodium.typology, frame: parkingPodium.frame,
    estimatedUnits: estimateUnits(parkingPodium.spec, parkingPodium.typology, parkingPodium.frame), sink: sinkA,
  });
  assert.ok(planA.podiumStoreys > 1 || planA.basementStoreys > 0, 'nothing was added');
  assert.ok(sinkA.all().some(i => i.resolution?.id === 'add-podium-level' || i.resolution?.id === 'add-basement-level'));

  const retailPodium = framed({ ...base, massing: { ...base.massing!, podiumUse: 'retail' } });
  const sinkB = issueSink();
  const planB = solveParking({
    spec: retailPodium.spec, typology: retailPodium.typology, frame: retailPodium.frame,
    estimatedUnits: estimateUnits(retailPodium.spec, retailPodium.typology, retailPodium.frame), sink: sinkB,
  });
  assert.equal(planB.podiumStoreys, 1, 'a retail podium must not become a car park');
  assert.deepEqual(sinkB.all().filter(i => i.resolution?.id === 'add-podium-level'), []);
});

test('surface and garage schemes never grow a level: the shortfall is the packer\'s to report', () => {
  for (const id of ['au-walkup', 'us-detached', 'ca-laneway']) {
    const { spec, typology, frame } = framed(PRESETS.find(p => p.id === id)!.spec);
    const sink = issueSink();
    const plan = solveParking({ spec, typology, frame, estimatedUnits: estimateUnits(spec, typology, frame), sink });
    assert.equal(plan.basementStoreys, spec.massing.basementStoreys ?? 0, `${id} grew a basement`);
    assert.equal(plan.deferred, true, `${id} should defer to the packer`);
    assert.deepEqual(sink.all(), [], `${id} reported a shortfall before the yards were packed`);
  }
});

test("a car-free typology owes nothing", () => {
  const { spec, typology, frame } = framed(PRESETS.find(p => p.id === 'nz-coliving')!.spec);
  const sink = issueSink();
  const plan = solveParking({ spec, typology, frame, estimatedUnits: estimateUnits(spec, typology, frame), sink });
  assert.equal(plan.required, 0);
  assert.deepEqual(plan.levels, []);
  assert.deepEqual(sink.all(), []);
});

test('the solve is deterministic and idempotent once applied', () => {
  const { spec, typology, frame } = framed(PRESETS.find(p => p.id === 'ca-point-tower')!.spec);
  const units = estimateUnits(spec, typology, frame);
  const a = solveParking({ spec, typology, frame, estimatedUnits: units, sink: issueSink() });
  const b = solveParking({ spec, typology, frame, estimatedUnits: units, sink: issueSink() });
  assert.equal(JSON.stringify({ ...a, issues: [] }), JSON.stringify({ ...b, issues: [] }));
  // applying the plan and solving again must not keep adding levels
  applyParkingPlan(spec, typology, a);
  const c = solveParking({ spec, typology, frame, estimatedUnits: units, sink: issueSink() });
  assert.equal(c.basementStoreys, a.basementStoreys);
  assert.equal(applyParkingPlan(spec, typology, c), false, 'a settled plan must not touch the spec');
});

// ---------------------------------------------------------------------------
// Feeding the storey stack
// ---------------------------------------------------------------------------

test('applyParkingPlan re-resolves the floor list with the new parking levels', () => {
  const { spec, typology, frame } = framed(PRESETS.find(p => p.id === 'ca-point-tower')!.spec);
  const before = spec.floors.filter(f => f.index < 0).length;
  const plan = solveParking({ spec, typology, frame, estimatedUnits: estimateUnits(spec, typology, frame), sink: issueSink() });
  assert.equal(applyParkingPlan(spec, typology, plan), true);
  const basements = spec.floors.filter(f => f.index < 0);
  assert.equal(basements.length, plan.basementStoreys);
  assert.ok(basements.length > before);
  for (const b of basements) assert.equal(b.use, 'parking', `basement ${b.index} is not parking`);
  // the residential floors are untouched
  assert.equal(spec.floors.filter(f => f.index >= 0).length, spec.massing.storeys);
  assert.equal(spec.massing.basementStoreys, plan.basementStoreys);
  // packing order: the requested type's own levels first
  assert.deepEqual(parkingFloors(spec, 'underground').map(f => f.index), [-1, -2]);
  assert.deepEqual(parkingFloors(spec, 'podium').map(f => f.index), [-1, -2]);
});

test('every parking storey is packed, and the stalls stay inside the plate', () => {
  const spec = normalizeSpec(PRESETS.find(p => p.id === 'ca-point-tower')!.spec);
  const typology = getTypology(spec.typology);
  const site = generateSite(spec, typology, createRng(spec.seed).fork('site'), []);
  const byStorey = new Map<string, number>();
  for (const s of site.parking!.spaces) byStorey.set(s.storey, (byStorey.get(s.storey) ?? 0) + 1);
  assert.equal(byStorey.size, 2, `stalls on ${[...byStorey.keys()].join('+')}`);
  assert.ok(site.parking!.spaces.length >= site.derived.parkingRequired, 'shortfall on a solved plan');
  const zone = structuredZone({ x: 0, y: 0, w: spec.site.width, h: spec.site.depth });
  for (const s of site.parking!.spaces) {
    assert.ok(s.rect.x >= zone.x - 1 && s.rect.y >= zone.y - 1, `${s.id} outside the plate`);
  }
  // one ramp per parking storey
  const ramps = site.elements.filter(e => e.objectType === 'ParkingRamp');
  assert.equal(ramps.length, 2);
  assert.deepEqual([...new Set(ramps.map(r => r.storey))].sort(), ['B1', 'B2']);
});
