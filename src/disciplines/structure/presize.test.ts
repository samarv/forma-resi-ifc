/**
 * Structural pre-sizing tests. Run with:
 *   node --test src/disciplines/structure/presize.test.ts
 *
 * The pre-sizing is the SINGLE OWNER of every structural number the other disciplines read, so these tests are
 * mostly about ownership and identity rather than about geometry:
 *   - slab thickness and core-wall thickness come from here and nowhere else;
 *   - the transfer storey is `storeyIdFor(podiumStoreys)` and the storey below it carries the transfer zone
 *     (the v1 off-by-one between architecture and structure);
 *   - a ceiling profile that cannot fit RAISES the floor-to-floor and records a deviation;
 *   - `bayOffsets` stays inside the admissible bay band;
 *   - the proposed grid is identical on every residential storey (no per-storey kinks).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { BuildingSpec, StoreyDef, TypologyDef, SiteModel, MassingModel } from '../../core/types.ts';
import { buildStoreys, normalizeSpec } from '../../core/spec.ts';
import { getTypology } from '../../core/typologies.ts';
import { polygonArea, rectToPolygon } from '../../core/geometry.ts';
import { storeyIdFor } from '../../core/ids.ts';

import { bayGridFrom, bayOffsets, presizeStructure, proposeBay, type StructuralPresize } from './presize.ts';
import { createProfileBook } from './profiles-seam.ts';
import { collectingLedger, passthroughRuleSet } from './fallbacks.ts';
import { allFixtures } from './test-fixtures.ts';
import { GRID_RULES, TRANSFER } from './sizing.ts';

const rules = passthroughRuleSet();
const profiles = createProfileBook(rules);

/** A coherent SiteModel without depending on the site discipline (which is being rewritten in parallel) */
function siteFor(spec: BuildingSpec, t: TypologyDef, storeys: StoreyDef[]): SiteModel {
  const w = Math.max(12, Math.min(spec.site.width - 6, spec.massing.buildingLength ?? (spec.site.width - 6)));
  const d = spec.massing.buildingDepth ?? t.buildingDepth.default;
  const rect = { x: 3, y: 3, w, h: d };
  const poly = rectToPolygon(rect);
  const axis: 'x' | 'y' = w >= d ? 'x' : 'y';
  const massing: MassingModel = {
    shape: spec.massing.footprintShape ?? t.footprintShapes[0],
    footprint: poly,
    footprintArea: polygonArea(poly),
    bars: [{ id: 'BAR-1', rect, axis, depth: d, length: w, exteriorSides: [] }],
    storeys,
    heightAboveGrade: 20,
    gfa: polygonArea(poly) * spec.massing.storeys,
    cores: [{ id: 'SIT-CORE-1', rect: { x: rect.x + w / 2 - 2.5, y: rect.y + d / 2 - 3.5, w: 5, h: 7 }, barId: 'BAR-1', type: 'stair-elevator', hasElevator: true, elevatorCount: 1 }],
    corridors: t.access === 'direct' ? [] : [{
      id: 'SIT-CORR-1', barId: 'BAR-1',
      centerline: { a: [rect.x, rect.y + d / 2], b: [rect.x + w, rect.y + d / 2] },
      width: spec.massing.corridorWidth ?? 1.5, loaded: 'both',
    }],
    roof: { type: spec.massing.roof, pitchRad: 0, parapetHeight: 1.1, ridgeAxis: 'x' },
  };
  return {
    boundary: rectToPolygon({ x: 0, y: 0, w: spec.site.width, h: spec.site.depth }),
    area: spec.site.width * spec.site.depth,
    buildableEnvelope: poly,
    setbacks: { front: 3, side: 3, rear: 3 },
    streetFacing: spec.site.streetFacing,
    northRad: 0,
    massing,
    parking: null,
    landscape: [],
    paths: [],
    driveway: null,
    entrances: [],
    elements: [],
    patterns: [],
    derived: {},
  };
}

interface Case { id: string; spec: BuildingSpec; typology: TypologyDef; storeys: StoreyDef[]; site: SiteModel; presize: StructuralPresize; issues: ReturnType<typeof collectingLedger> }

function presizeOf(id: string, partial: Parameters<typeof normalizeSpec>[0]): Case {
  const spec = normalizeSpec(partial);
  const typology = getTypology(spec.typology);
  const storeys = buildStoreys(spec, spec.floors);
  const site = siteFor(spec, typology, storeys);
  const issues = collectingLedger();
  return { id, spec, typology, storeys, site, issues, presize: presizeStructure({ spec, typology, site, storeys, profiles, rules, ledger: issues }) };
}

const CASES: Case[] = [
  presizeOf('midrise', { typology: 'corridor-midrise', seed: 7, region: 'US', massing: { storeys: 6, podiumStoreys: 1, podiumUse: 'parking', roof: 'flat' } }),
  presizeOf('tower', { typology: 'podium-tower', seed: 11, region: 'CA', massing: { storeys: 22, podiumStoreys: 3, podiumUse: 'retail', basementStoreys: 1, roof: 'flat' } }),
  presizeOf('terrace', { typology: 'townhouse-row', seed: 3, region: 'UK', massing: { storeys: 3, roof: 'gable' } }),
  presizeOf('walkup', { typology: 'garden-walkup', seed: 5, region: 'AU', massing: { storeys: 3, roof: 'flat' } }),
];

// ----------------------------------------------------------------------------
// Single ownership
// ----------------------------------------------------------------------------

test('the pre-sizing is the single owner of slab, core-wall and shear-wall thickness', () => {
  for (const c of CASES) {
    const p = c.presize;
    assert.ok(p.sizes.slabT >= 0.15 && p.sizes.slabT <= 0.4, `${c.id}: implausible slab ${p.sizes.slabT}`);
    assert.equal(p.coreWallT, p.shearWallT, `${c.id}: coreWallT and shearWallT must be one number`);
    assert.equal(p.sizes.shearWallT, p.shearWallT, `${c.id}: sizes.shearWallT must be the same number`);
    // 0.25 m is a 2-hour RC fire enclosure; 0.30 m is an ACI 318-19 §18.10 special structural wall
    assert.ok(p.coreWallT === 0.25 || p.coreWallT === 0.3, `${c.id}: core wall ${p.coreWallT} is neither 0.25 nor 0.30`);
    assert.ok(p.partyWallT > 0 && p.exteriorWallT > 0 && p.corridorWallT > 0, `${c.id}: wall thicknesses missing`);

    // Every storey has exactly one entry and the map agrees with the list
    assert.equal(p.byStorey.size, p.storeys.length, `${c.id}: byStorey and storeys disagree`);
    for (const s of p.storeys) {
      assert.equal(p.byStorey.get(s.storey), s, `${c.id}: ${s.storey} missing from byStorey`);
      assert.ok(s.slabTAbove > 0, `${c.id}: ${s.storey} has no slab above`);
      assert.ok(s.soffitZ > 0 && s.soffitZ <= s.floorToFloor, `${c.id}: ${s.storey} soffit ${s.soffitZ} vs f2f ${s.floorToFloor}`);
      assert.ok(s.corridorSoffitZ <= s.soffitZ + 1e-9, `${c.id}: ${s.storey} corridor soffit is above the slab soffit`);
      // `roof-plant` stacks UP from the membrane, so its ceiling is not measured down from a soffit.
      if (s.profileId === 'roof-plant') continue;
      assert.ok(s.ceilingZ <= s.corridorSoffitZ + 1e-9, `${c.id}: ${s.storey} ceiling is inside the structure`);
      assert.ok(s.corridorCeilingZ <= s.corridorSoffitZ + 1e-9, `${c.id}: ${s.storey} corridor ceiling is inside the structure`);
    }
  }
});

test('a shear core is 0.30 m and a low-rise core is 0.25 m', () => {
  const tower = CASES.find(c => c.id === 'tower')!.presize;
  const terrace = CASES.find(c => c.id === 'terrace')!.presize;
  assert.equal(tower.system, 'rc-flat-plate-core');
  assert.equal(tower.coreWallT, 0.3, 'a 22-storey shear core wants 0.30 m (ACI 318-19 §18.10.2.1)');
  assert.equal(terrace.coreWallT, 0.25, 'a 3-storey terrace does not need a special structural wall');
});

test('the corridor plenum depth and the unit ceiling come from the resolved profile, not a constant', () => {
  const midrise = CASES.find(c => c.id === 'midrise')!.presize;
  const typical = midrise.storeys.find(s => s.use === 'residential');
  assert.ok(typical, 'no residential storey');
  // resi-corridor needs beamD + 0.80 of plenum and 2.10 m of clear height (IBC 2021 §1003.2)
  assert.ok(typical.corridorCeilingZ >= 2.1 - 1e-9, `corridor ceiling ${typical.corridorCeilingZ} is below the 2.10 m minimum`);
  assert.ok(typical.ceilingZ >= 2.3 - 1e-9, `unit ceiling ${typical.ceilingZ} is below the 2.30 m minimum`);
  assert.ok(typical.ceilingZ > typical.corridorCeilingZ, 'the dwelling ceiling must be higher than the corridor ceiling');
});

// ----------------------------------------------------------------------------
// Transfer storey identity (the v1 off-by-one)
// ----------------------------------------------------------------------------

test('the transfer storey is storeyIdFor(podiumStoreys) and the storey below carries the zone', () => {
  for (const c of CASES) {
    const p = c.presize;
    if (p.podiumStoreys === 0) {
      assert.equal(p.transferStorey, null, `${c.id}: no podium, no transfer storey`);
      assert.equal(p.transferBelowStorey, null, `${c.id}: no podium, no transfer-below storey`);
      assert.ok(p.storeys.every(s => !s.isTransferBelow), `${c.id}: a storey claims to be below a transfer slab`);
      continue;
    }
    assert.equal(p.transferStorey, storeyIdFor(p.podiumStoreys), `${c.id}: transfer storey`);
    assert.equal(p.transferBelowStorey, storeyIdFor(p.podiumStoreys - 1), `${c.id}: transfer-below storey`);
    assert.equal(p.transferSlabT, TRANSFER.slabT, `${c.id}: transfer slab thickness`);
    assert.equal(p.transferZoneDepth, TRANSFER.slabT + TRANSFER.beamD, `${c.id}: transfer zone depth`);

    const below = p.byStorey.get(p.transferBelowStorey!);
    assert.ok(below, `${c.id}: no sizing for the transfer-below storey`);
    assert.equal(below.isTransferBelow, true, `${c.id}: ${below.storey} must be flagged isTransferBelow`);
    assert.equal(below.slabTAbove, 0.3, `${c.id}: the slab above ${below.storey} is the transfer slab (0.30 m)`);
    assert.equal(below.transferZoneDepth, 1.2, `${c.id}: ${below.storey} carries the 1.20 m transfer zone`);

    const transfer = p.byStorey.get(p.transferStorey!);
    assert.ok(transfer, `${c.id}: no sizing for the transfer storey`);
    assert.equal(transfer.slabTOwn, 0.3, `${c.id}: the transfer storey's OWN slab is the thick one`);
    assert.equal(transfer.transferZoneDepth, 0, `${c.id}: the transfer storey itself is not below a transfer slab`);

    // exactly one storey is flagged, and exactly one owns a thickened slab
    assert.equal(p.storeys.filter(s => s.isTransferBelow).length, 1, `${c.id}: more than one transfer-below storey`);
    assert.equal(p.storeys.filter(s => s.slabTOwn === 0.3 && s.storey === p.transferStorey).length, 1, `${c.id}: transfer slab is not on exactly one storey`);
  }
});

// ----------------------------------------------------------------------------
// raise-floor-to-floor
// ----------------------------------------------------------------------------

test('a retail ground floor that cannot hold the transfer zone raises its floor-to-floor', () => {
  // 3.0 m retail under a 0.30 slab + 0.90 transfer beam leaves 1.80 m of clear height; the retail-shell profile
  // wants 2.70 m (IBC 2021 §1208.2) plus a landlord/tenant plenum, so the storey has to get taller.
  const c = presizeOf('tight-retail', {
    typology: 'podium-tower', seed: 11, region: 'CA',
    massing: { storeys: 14, podiumStoreys: 1, podiumUse: 'retail', groundFloorToFloor: 3.0, roof: 'flat' },
  });
  const ground = c.presize.byStorey.get('L01');
  assert.ok(ground, 'no L01');
  assert.equal(ground.isTransferBelow, true, 'L01 must be the transfer-below storey');
  assert.ok(ground.floorToFloor > 3.0 + 1e-9, `L01 floor-to-floor was not raised (still ${ground.floorToFloor})`);
  assert.ok(Math.abs(Math.round(ground.floorToFloor / 0.05) * 0.05 - ground.floorToFloor) < 1e-6, 'the raise must land on a 50 mm step');
  assert.ok(ground.ceilingZ >= profiles.profile(ground.profileId).clearHeight.min - 1e-6,
    `the raised storey still does not give the ${ground.profileId} clear height (${ground.ceilingZ})`);

  const raise = c.presize.issues.find(i => i.ruleId === 'XD-02.plenumDepth' && i.storey === 'L01');
  assert.ok(raise, 'no deviation recorded for the raise');
  assert.equal(raise.severity, 'deviation', 'a raise is a recorded resolution, not a violation');
  assert.equal(raise.resolution?.id, 'raise-floor-to-floor', 'the resolution must be named');
  assert.equal(raise.resolution?.from, 3, 'the deviation must record the original height');
  assert.equal(raise.resolution?.to, ground.floorToFloor, 'the deviation must record the new height');
  assert.ok(c.issues.bySeverity('deviation').length >= 1, 'the ledger must have the deviation too');

  // storeysResolved carries the new height AND recomputed elevations for everything above it
  const resolved = new Map(c.presize.storeysResolved.map(s => [s.id, s]));
  assert.equal(resolved.get('L01')!.height, ground.floorToFloor, 'storeysResolved does not carry the raised height');
  assert.equal(resolved.get('L01')!.elevation, 0, 'the ground floor stays at elevation 0');
  assert.equal(resolved.get('L02')!.elevation, ground.floorToFloor, 'L02 elevation was not recomputed');
  const roof = resolved.get('ROOF')!;
  const original = c.storeys.find(s => s.id === 'ROOF')!;
  assert.ok(roof.elevation > original.elevation, 'the roof did not move up with the raised storey');
  assert.equal(roof.height, original.height, 'the parapet height must not change');
  const fnd = resolved.get('FND')!;
  assert.equal(fnd.elevation, c.storeys.find(s => s.id === 'FND')!.elevation, 'a raise above grade must not move the foundation');
});

test('a raise is bounded, recorded, and actually resolves the profile it was asked for', () => {
  for (const c of CASES) {
    const raises = c.presize.issues.filter(i => i.ruleId === 'XD-02.plenumDepth');
    const raisedStoreys = new Set(raises.map(i => i.storey));
    for (const s of c.presize.storeys) {
      const original = c.storeys.find(x => x.id === s.storey);
      assert.ok(original, `${c.id}: ${s.storey} is not in the storey list`);
      if (Math.abs(s.floorToFloor - original.height) < 1e-9) {
        assert.ok(!raisedStoreys.has(s.storey), `${c.id}: ${s.storey} reports a raise it did not apply`);
        continue;
      }
      // Every raise: upward only, on a 50 mm step, bounded, recorded once, and it fixes what it was asked to fix.
      assert.ok(s.floorToFloor > original.height, `${c.id}: ${s.storey} was LOWERED`);
      assert.ok(s.floorToFloor - original.height <= 2.5 + 1e-9, `${c.id}: ${s.storey} raised by more than the 2.5 m cap`);
      assert.ok(Math.abs(Math.round(s.floorToFloor / 0.05) * 0.05 - s.floorToFloor) < 1e-6, `${c.id}: ${s.storey} raise is not on a 50 mm step`);
      assert.ok(raisedStoreys.has(s.storey), `${c.id}: ${s.storey} was raised without a deviation`);
      assert.equal(raises.filter(i => i.storey === s.storey).length, 1, `${c.id}: ${s.storey} recorded more than one raise`);
      const rec = raises.find(i => i.storey === s.storey)!;
      assert.equal(rec.resolution?.from, Number(original.height.toFixed(3)), `${c.id}: ${s.storey} deviation 'from'`);
      assert.equal(rec.resolution?.to, Number(s.floorToFloor.toFixed(3)), `${c.id}: ${s.storey} deviation 'to'`);
      const min = profiles.profile(s.profileId).clearHeight.min;
      assert.ok(s.ceilingZ >= min - 1e-6, `${c.id}: ${s.storey} still only gives ${s.ceilingZ} m under a ${min} m minimum after the raise`);
    }
  }
});

test('storeysResolved is the input list when nothing was raised', () => {
  const c = CASES.find(x => x.id === 'terrace')!;
  assert.equal(c.presize.storeysResolved.length, c.storeys.length);
  for (const s of c.presize.storeysResolved) {
    const original = c.storeys.find(x => x.id === s.id)!;
    assert.equal(s.height, original.height, `${s.id} height changed`);
    assert.equal(s.elevation, original.elevation, `${s.id} elevation changed`);
    assert.equal(s.use, original.use);
    assert.equal(s.index, original.index);
  }
});

// ----------------------------------------------------------------------------
// The grid handshake
// ----------------------------------------------------------------------------

test('bayOffsets respects the bay band and absorbs the remainder in the corner bay', () => {
  const bands = [
    { min: 4.0, target: 7.5, max: 9.0, source: 'test' },
    { min: 6.0, target: 7.5, max: 9.0, source: 'test' },
    { min: 6.0, target: 9.0, max: 12.0, source: 'test' },
    { min: 4.0, target: 6.0, max: 9.0, source: 'test' },
  ];
  for (const bay of bands) {
    for (let span = bay.min; span <= 96; span += 0.37) {
      const offsets = bayOffsets(0, span, bay);
      assert.ok(offsets.length >= 2, `span ${span}: ${offsets.length} offsets`);
      assert.equal(offsets[0], 0, `span ${span}: first offset`);
      assert.ok(Math.abs(offsets[offsets.length - 1] - span) < 1e-6, `span ${span}: last offset ${offsets[offsets.length - 1]}`);
      for (let i = 1; i < offsets.length; i++) {
        const gap = offsets[i] - offsets[i - 1];
        assert.ok(gap > 0, `span ${span}: non-monotonic offsets`);
        // A single clear span may exceed the maximum by the split tolerance rather than collapse into two
        // bays shorter than the minimum (grid.ts SPLIT_TOLERANCE); every subdivided bay must obey the band.
        const cap = offsets.length === 2 ? bay.max * 1.12 : bay.max;
        assert.ok(gap <= cap + 1e-6, `span ${span.toFixed(2)}: bay ${gap.toFixed(3)} exceeds ${cap.toFixed(3)}`);
        // Spans in (max x 1.12, 2 x min) cannot satisfy both bounds; the maximum wins, because a long span the
        // slab cannot carry is a defect and a short bay is only uneconomic.
        const feasible = span >= 2 * bay.min;
        if (offsets.length > 2 && feasible) assert.ok(gap >= bay.min - 1e-6, `span ${span.toFixed(2)}: bay ${gap.toFixed(3)} is below min ${bay.min}`);
      }
    }
  }
  // degenerate input never throws
  assert.deepEqual(bayOffsets(5, 5, bands[0]), [5]);
  assert.deepEqual(bayOffsets(5, 4, bands[0]), [5]);
});

test('the grid proposal covers every bar and stays inside the bay band', () => {
  for (const c of CASES) {
    const g = c.presize.gridProposal;
    const bars = c.site.massing.bars;
    assert.equal(g.transverse.length, bars.length, `${c.id}: a bar has no transverse lines`);
    assert.equal(g.longitudinal.length, bars.length, `${c.id}: a bar has no longitudinal lines`);
    assert.equal(g.longAxis, bars[0].axis, `${c.id}: long axis`);
    assert.equal(g.parkingModule.along, TRANSFER.moduleAlong, `${c.id}: parking module along`);
    assert.equal(g.parkingModule.across, TRANSFER.moduleAcross, `${c.id}: parking module across`);
    assert.equal(g.snapTolerance, GRID_RULES.snapDistance, `${c.id}: snap tolerance`);
    assert.ok(g.bay.source.length > 10, `${c.id}: the bay band needs a source`);
    assert.ok(g.bay.min <= g.bay.target && g.bay.target <= g.bay.max, `${c.id}: bay band is not ordered`);

    for (const t of g.transverse) {
      assert.equal(t.axis, bars.find(b => b.id === t.barId)!.axis, `${c.id}: transverse lines must be perpendicular to the bar`);
      assert.ok(t.offsets.length >= 2, `${c.id}: bar ${t.barId} has ${t.offsets.length} transverse lines`);
      for (let i = 1; i < t.offsets.length; i++) {
        assert.ok(t.offsets[i] > t.offsets[i - 1], `${c.id}: transverse offsets are not sorted`);
        assert.ok(t.offsets[i] - t.offsets[i - 1] <= g.bay.max + 1e-6, `${c.id}: transverse bay ${(t.offsets[i] - t.offsets[i - 1]).toFixed(2)} exceeds ${g.bay.max}`);
      }
    }
    for (const l of g.longitudinal) {
      assert.notEqual(l.axis, bars.find(b => b.id === l.barId)!.axis, `${c.id}: longitudinal lines run along the bar`);
      assert.ok(l.offsets.length >= 2, `${c.id}: bar ${l.barId} has ${l.offsets.length} longitudinal lines`);
    }
  }
});

test('the proposal is one grid for the whole building: identical on every residential storey', () => {
  // The proposal is derived from site.massing only, so there is nothing per-storey that could kink. This test
  // pins that property: the offsets a storey would snap to are the same object for every storey.
  for (const c of CASES) {
    const g = c.presize.gridProposal;
    const residential = c.presize.storeys.filter(s => s.use === 'residential');
    assert.ok(residential.length >= 1, `${c.id}: no residential storey`);
    const key = JSON.stringify([g.transverse, g.longitudinal]);
    for (const s of residential) {
      const again = presizeStructure({
        spec: c.spec, typology: c.typology, site: c.site, storeys: c.storeys, profiles, rules, ledger: collectingLedger(),
      }).gridProposal;
      assert.equal(JSON.stringify([again.transverse, again.longitudinal]), key, `${c.id}: the grid differs on ${s.storey}`);
    }
  }
});

test('bayGridFrom hands the placer the pre-sized numbers', () => {
  for (const c of CASES) {
    const bg = bayGridFrom(c.presize);
    assert.equal(bg.source, 'presize');
    assert.equal(bg.coreWallT, c.presize.coreWallT, `${c.id}: core wall`);
    assert.equal(bg.shearWallT, c.presize.shearWallT, `${c.id}: shear wall`);
    assert.equal(bg.bay.min, c.presize.gridProposal.bay.min, `${c.id}: bay min`);
    assert.equal(bg.bay.max, c.presize.gridProposal.bay.max, `${c.id}: bay max`);
    assert.ok(bg.slabT > 0, `${c.id}: slab thickness`);
  }
});

test('proposeBay is pure and sourced', () => {
  for (const c of CASES) {
    const a = proposeBay(c.typology, c.site, c.spec, rules);
    const b = proposeBay(c.typology, c.site, c.spec, rules);
    assert.deepEqual(a, b, `${c.id}: proposeBay is not deterministic`);
    assert.ok(a.source.includes('span') || a.source.includes('rhythm') || a.source.includes('deck') || a.source.includes('module') || a.source.includes('Guide') || a.source.includes('tables'), `${c.id}: bay source '${a.source}' is not a real citation`);
  }
});

// ----------------------------------------------------------------------------
// Determinism and the fixtures
// ----------------------------------------------------------------------------

test('the pre-sizing is deterministic and runs on every structure fixture', () => {
  for (const f of allFixtures()) {
    const input = { spec: f.spec, typology: f.typology, site: f.site, storeys: f.storeys, profiles, rules };
    const a = presizeStructure({ ...input, ledger: collectingLedger() });
    const b = presizeStructure({ ...input, ledger: collectingLedger() });
    assert.equal(JSON.stringify(a.storeys), JSON.stringify(b.storeys), `${f.id}: storey sizing is not deterministic`);
    assert.equal(JSON.stringify(a.gridProposal), JSON.stringify(b.gridProposal), `${f.id}: grid proposal is not deterministic`);
    assert.equal(JSON.stringify(a.sizes), JSON.stringify(b.sizes), `${f.id}: sizes are not deterministic`);
    for (const s of a.storeys) {
      for (const v of [s.slabTAbove, s.slabTOwn, s.beamDAbove, s.beamDAboveUnit, s.soffitZ, s.ceilingZ, s.corridorCeilingZ, s.floorToFloor]) {
        assert.ok(Number.isFinite(v), `${f.id}: non-finite sizing on ${s.storey}`);
      }
    }
  }
});

test('the pre-sizing needs no architecture and costs microseconds', () => {
  const c = CASES.find(x => x.id === 'tower')!;
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) {
    presizeStructure({ spec: c.spec, typology: c.typology, site: c.site, storeys: c.storeys, profiles, rules, ledger: collectingLedger() });
  }
  const ms = (performance.now() - t0) / 20;
  assert.ok(ms < 10, `the pre-sizing takes ${ms.toFixed(2)} ms per call (budget 10 ms)`);
});
