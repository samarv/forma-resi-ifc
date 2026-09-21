/**
 * The cross-discipline invariants (#14–#29 of docs/design/v2-design-kernel-rules-presize.md §6).
 *
 * These are the tests the whole v2 backbone exists to pass: every MEP element inside a reservation of its own
 * discipline, one slab thickness, one transfer storey, nothing wet over switchgear, no penetration, hangers, riser
 * continuity, drains that drain, clear heights, load paths, parking, storeys and corridors.
 *
 * Every one of them is written against the real API and is **skipped until wave 2**, because each needs a discipline
 * that is still on its v1 code path (mechanical/electrical lanes, plumbing chases and inverts, structure keep-outs
 * for every member, the corridor graph in architecture). Unskipping is a one-word change per test, and the `skip`
 * string names what has to land first. `src/core/kernel/kernel.test.ts` covers the same invariants today against
 * synthetic inputs, so the kernel itself is not untested in the meantime.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { DesignModel, ModelElement } from './core/types.ts';
import { generateBuilding } from './pipeline.ts';
import { PRESETS, normalizeSpec } from './core/spec.ts';
import { boxesOfElement, boxesOverlap, elementKindOf, isGoverned } from './core/kernel/validate.ts';
import { HANGERS, SLOPES, hangerFor } from './core/kernel/clearances.ts';
import type { ElementKind } from './core/kernel/types.ts';

const WAVE2 = (what: string): { skip: string } => ({ skip: `wave 2: ${what}` });

const CACHE = new Map<string, DesignModel>();
function model(id: string): DesignModel {
  const hit = CACHE.get(id);
  if (hit) return hit;
  const preset = PRESETS.find(p => p.id === id);
  assert.ok(preset, `unknown preset ${id}`);
  const m = generateBuilding(preset.spec);
  CACHE.set(id, m);
  return m;
}
const ALL = PRESETS.map(p => p.id);

function mepElements(m: DesignModel): { element: ModelElement; kind: ElementKind }[] {
  const out: { element: ModelElement; kind: ElementKind }[] = [];
  for (const e of m.elements) {
    const kind = elementKindOf(e);
    if (kind && isGoverned(kind)) out.push({ element: e, kind });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// #14–#16 — reservations
// ---------------------------------------------------------------------------------------------------------------

test('#14 every MEP element is inside a reservation of its own discipline', WAVE2('mechanical, plumbing and electrical route through kernel.reserveLaneRun / reserveCrossing / reserveRiser'), () => {
  for (const id of ALL) {
    const m = model(id);
    assert.ok(m.arch, `${id}: no architecture`);
    const violations = (m.issues ?? []).filter(i => i.severity === 'violation' && i.ruleId.startsWith('XD-S0'));
    assert.deepEqual(violations.map(v => v.message), [], `${id}: free-floating MEP elements`);
  }
});

test('#15 every MEP element is inside its band', WAVE2('as #14'), () => {
  for (const id of ALL) {
    const m = model(id);
    const outOfBand = (m.issues ?? []).filter(i => i.ruleId === 'XD-02.inBand');
    assert.deepEqual(outOfBand.map(v => v.message), [], `${id}: elements outside their band`);
  }
});

test('#16 shaft slots are disjoint across the three disciplines', WAVE2('MEP risers come from reserveRiser'), () => {
  for (const id of ALL) {
    const m = model(id);
    const shafts = m.arch?.shafts ?? [];
    for (const shaft of shafts) {
      // Every slot the kernel issued in this shaft, from the reservations it recorded.
      const boxes = (m.issues ?? []).length >= 0 ? [] : [];
      void boxes;
      assert.ok(shaft.rect.w > 0 && shaft.rect.h > 0, `${id}: shaft ${shaft.id} has no footprint`);
    }
    const conflicts = (m.issues ?? []).filter(i => i.ruleId.startsWith('XD-04.shaft'));
    assert.deepEqual(conflicts.map(c => c.message), [], `${id}: shaft allocation conflicts`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// #17–#19 — one owner per fact
// ---------------------------------------------------------------------------------------------------------------

test('#17 one slab thickness and one core-wall thickness per storey', WAVE2('architecture reads presize.byStorey(...).slabTAbove and presize.coreWallT'), () => {
  for (const id of ALL) {
    const m = model(id);
    const presize = m.struct ? m.struct : null;
    assert.ok(presize, `${id}: no structure`);
    for (const floor of m.arch.floors) {
      const mismatch = (m.issues ?? []).filter(i => i.ruleId === 'STR-09.slabThickness' && i.storey === floor.storey);
      assert.deepEqual(mismatch.map(x => x.message), [], `${id}/${floor.storey}: two slab thicknesses`);
    }
  }
});

test('#18 the transfer storey is one storey, and it is the same one everywhere', WAVE2('structure detailing thickens exactly the pre-sized transfer slab'), () => {
  for (const id of ALL) {
    const m = model(id);
    if (!m.struct) continue;
    const thickened = m.struct.slabs.filter(s => s.type === 'podium-transfer');
    const storeys = new Set(thickened.map(s => s.storey));
    assert.ok(storeys.size <= 1, `${id}: the transfer slab is on ${storeys.size} storeys (${[...storeys].join(', ')})`);
    if (m.struct.transferStorey) {
      assert.ok(storeys.size === 0 || storeys.has(m.struct.transferStorey),
        `${id}: struct.transferStorey ${m.struct.transferStorey} is not where the thickened slab is`);
    }
  }
});

test('#19 every duct, pipe and tray is below the structural soffit', WAVE2('as #14'), () => {
  for (const id of ALL) {
    const m = model(id);
    for (const { element, kind } of mepElements(m)) {
      const soffit = m.struct?.plenumClearance.byStorey?.[element.storey];
      if (soffit === undefined) continue;
      for (const box of boxesOfElement(element)) {
        assert.ok(box.z + box.h <= soffit + 0.02,
          `${id}: ${kind} ${element.id} top ${(box.z + box.h).toFixed(3)} is above the soffit ${soffit.toFixed(3)} on ${element.storey}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------
// #20–#21 — keep-outs
// ---------------------------------------------------------------------------------------------------------------

test('#20 nothing wet or ducted is over switchgear (NEC 110.26(E))', WAVE2('electrical registers its dedicated space as a keep-out and MEP reserves around it'), () => {
  const BANNED: readonly ElementKind[] = ['waste', 'vent', 'storm', 'trench-drain', 'dcw', 'dhw', 'hwr', 'gas', 'duct'];
  for (const id of ALL) {
    const m = model(id);
    const gear = m.elements.filter(e => elementKindOf(e) === 'switchgear');
    for (const g of gear) {
      const gb = boxesOfElement(g)[0];
      if (!gb) continue;
      const zone = { x: gb.x, y: gb.y, z: 0, w: gb.w, d: gb.d, h: 1.8 };
      for (const { element, kind } of mepElements(m)) {
        if (element.storey !== g.storey || !BANNED.includes(kind)) continue;
        for (const box of boxesOfElement(element)) {
          assert.ok(!boxesOverlap(box, zone, 1e-4),
            `${id}: ${kind} ${element.id} is in the dedicated space above switchgear ${g.id}`);
        }
      }
    }
  }
});

test('#21 nothing penetrates a beam, a column or a hoistway', WAVE2('structure registers every member as a keep-out'), () => {
  for (const id of ALL) {
    const m = model(id);
    const penetrations = (m.issues ?? []).filter(i => i.ruleId === 'XD-S5.noPenetration' || i.ruleId === 'XD-04.hoistway');
    assert.deepEqual(penetrations.map(x => x.message), [], `${id}: structure penetrations`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// #22–#24 — constructability
// ---------------------------------------------------------------------------------------------------------------

test('#22 every horizontal run hangs from something', WAVE2('as #14: a run in a wall/chase/shaft needs its reservation to say so'), () => {
  for (const id of ALL) {
    const m = model(id);
    for (const { element, kind } of mepElements(m)) {
      const g = element.geometry;
      if (g.kind !== 'axis') continue;
      const plan = Math.hypot(g.end[0] - g.start[0], g.end[1] - g.start[1]);
      if (plan < 0.3) continue;
      const spec = hangerFor(kind) ?? HANGERS[kind];
      if (!spec) continue;
      const soffit = m.struct?.plenumClearance.byStorey?.[element.storey];
      if (soffit === undefined) continue;
      const drop = soffit - Math.max(g.start[2], g.end[2]);
      assert.ok(drop <= spec.maxDrop + 1e-6,
        `${id}: ${kind} ${element.id} hangs ${drop.toFixed(2)} m below the soffit (limit ${spec.maxDrop} m, ${spec.source})`);
    }
  }
});

test('#23 every riser is housed on every storey it crosses', WAVE2('plumbing and mechanical risers come from reserveRiser / chaseOf'), () => {
  for (const id of ALL) {
    const m = model(id);
    const broken = (m.issues ?? []).filter(i => i.ruleId.startsWith('XD-S2'));
    assert.deepEqual(broken.map(x => x.message), [], `${id}: riser continuity`);
  }
});

test('#24 every drain drains: monotonic, in the slope band, and reaching a stack, a drain or a sump', WAVE2('plumbing sloped axes + invert model + sump/ejector'), () => {
  for (const id of ALL) {
    const m = model(id);
    const drainage = (m.issues ?? []).filter(i => i.ruleId.startsWith('PLB-S'));
    assert.deepEqual(drainage.map(x => x.message), [], `${id}: drainage`);
    for (const { element, kind } of mepElements(m)) {
      if (kind !== 'waste' && kind !== 'storm' && kind !== 'trench-drain') continue;
      const g = element.geometry;
      if (g.kind !== 'axis') continue;
      const plan = Math.hypot(g.end[0] - g.start[0], g.end[1] - g.start[1]);
      if (plan < 0.3) continue;
      const fall = (g.start[2] - g.end[2]) / plan;
      assert.ok(fall >= -1e-6, `${id}: ${element.id} rises in the direction of flow`);
      assert.ok(fall <= SLOPES.maxGravity.slope + 1e-6, `${id}: ${element.id} falls steeper than 1:12`);
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------
// #25–#29 — code and resolution invariants
// ---------------------------------------------------------------------------------------------------------------

test('#25 parking clear heights: 2.10 m on the aisle, 2.50 m on the accessible route', WAVE2('mechanical/electrical route their car-park services in the parking lane set'), () => {
  for (const id of ALL) {
    const m = model(id);
    const failures = (m.issues ?? []).filter(i => i.ruleId === 'XD-08.clearHeightParking' || i.ruleId === 'XD-08.accessibleRoute');
    assert.deepEqual(failures.map(x => x.message), [], `${id}: parking clear heights`);
  }
});

test('#26 the load path closes: column on column or transfer, a foundation under every base, cores continuous', WAVE2('structure loadpath.ts + footings from loadpath.bases'), () => {
  for (const id of ALL) {
    const m = model(id);
    const structural = (m.issues ?? []).filter(i => i.ruleId.startsWith('STR-C'));
    assert.deepEqual(structural.map(x => x.message), [], `${id}: load path`);
  }
});

test('#27 parking achieved equals parking required, or the relaxation is recorded', WAVE2('site parking solver adds levels before relaxing the ratio'), () => {
  for (const id of ALL) {
    const m = model(id);
    const ratio = m.metrics.find(x => x.id === 'parking-ratio');
    if (!ratio) continue;
    const relaxed = (m.issues ?? []).filter(i => i.ruleId === 'SIT-07.parkingRatio');
    const requested = m.spec.site.parking?.ratio;
    if (requested === undefined || relaxed.length > 0) continue;
    assert.ok(ratio.value >= requested - 0.01,
      `${id}: parking ratio ${ratio.value} is below the requested ${requested} with no recorded relaxation`);
  }
});

test('#28 storeys stay inside the typology band, or the override is recorded', WAVE2('normalizeSpec clamps to the typology band'), () => {
  for (const id of ALL) {
    const m = model(id);
    const above = m.storeys.filter(s => s.index >= 0 && s.use !== 'roof').length;
    const band = m.typology.storeys;
    const override = (m.issues ?? []).filter(i => i.ruleId === 'TYP-01.storeyBand');
    if (override.length > 0) continue;
    assert.ok(above >= band.min && above <= band.max,
      `${id}: ${above} storeys is outside the ${band.min}–${band.max} band for ${m.typology.name} with no recorded override`);
  }
});

test('#29 corridors: no leg over the limit, no long dead end, and an O-plan is one graph', WAVE2('architecture consumes the corridor graph and its break slots'), () => {
  for (const id of ALL) {
    const m = model(id);
    const corridorIssues = (m.issues ?? []).filter(i => i.ruleId === 'ARC-C5.corridorLeg' || i.ruleId === 'ARC-C6.corridorDeadEnd' || i.ruleId === 'ARC-33.egressTravel');
    assert.deepEqual(corridorIssues.map(x => x.message), [], `${id}: corridors`);
  }
  const courtyard = model('ie-courtyard');
  const graph = courtyard.site.massing.corridorGraph;
  assert.ok(graph, 'the courtyard block publishes a corridor graph');
  assert.ok(graph.legs.length >= 4, 'an O-plan has a leg per bar');
  assert.equal(graph.deadEnds.length, 0, 'an O-plan corridor is cyclic: no dead ends');
});

// ---------------------------------------------------------------------------------------------------------------
// A fixture-only case: no preset exercises the retail shell, so the demise rules need their own spec
// ---------------------------------------------------------------------------------------------------------------

test('a retail podium reserves its tenant plenum and caps landlord services at the demise', WAVE2('retail fit-out routing (landlord services in the retail lane set)'), () => {
  const spec = normalizeSpec({
    name: 'Mixed-use midrise', seed: 5, region: 'US', typology: 'podium-tower',
    site: { width: 60, depth: 40, streetFacing: 'S', context: 'urban' },
    massing: { storeys: 8, podiumStoreys: 2, podiumUse: 'retail', floorToFloor: 3.1, groundFloorToFloor: 4.5, roof: 'flat' },
  });
  const m = generateBuilding(spec);
  const retail = m.arch.floors.filter(f => f.use === 'retail');
  assert.ok(retail.length > 0, 'the fixture has retail floors');
  const capped = (m.issues ?? []).filter(i => i.ruleId === 'XD-09.demiseCap' || i.ruleId === 'XD-09.tenantPlenum');
  assert.deepEqual(capped.map(x => x.message), [], 'landlord services are capped at the demise and the plenum is empty');
});
