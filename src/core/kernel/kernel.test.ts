/**
 * Kernel tests #1–#7 of docs/design/v2-design-kernel-rules-presize.md §6.
 *
 * These run on synthetic storeys, shafts and corridors rather than on generated presets: the invariants are
 * properties of the kernel (bands disjoint, slots disjoint, allocation order-independent), so they are stated
 * against inputs the test controls. The preset-wide versions live in `src/coordination.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ArchModel, ShaftDef, SiteModel, StoreyDef } from '../types.ts';
import type { StoreySizing, StructuralPresize } from '../../disciplines/structure/presize.ts';
import { createLedger } from '../rules/ledger.ts';
import { EMPTY_RULE_SET, createRuleSet } from '../rules/engine.ts';
import { builtinRules } from '../rules/builtin.ts';
import { createRng } from '../rng.ts';
import { getTypology } from '../typologies.ts';
import { normalizeSpec } from '../spec.ts';

import { PROFILE_DEFS, createProfileBook, stackProfile } from './profiles.ts';
import { LateralAllocator, StationAllocator, laneSetFor, requiredWidthOf } from './lanes.ts';
import { createKernel } from './registry.ts';
import { SHAFT_SYSTEM_ORDER, SHAFT_ZONE_OF, isConflict } from './types.ts';
import type { Box3, ProfileId, ResolvedBand, ShaftSystem } from './types.ts';
import { plenumBands } from '../coordination.ts';

const F2F = [2.7, 3.0, 3.05, 3.2, 4.0];
const SLAB = [0.2, 0.25, 0.3];
const BEAM = [0, 0.3, 0.5];
const TOL = 1e-6;

const RULES = createRuleSet({
  builtin: builtinRules(),
  fromPatterns: [],
  spec: normalizeSpec({ typology: 'corridor-midrise', site: { width: 60, depth: 40 }, massing: { storeys: 5, roof: 'flat' } }),
  typology: getTypology('corridor-midrise'),
  ledger: createLedger(),
});
const BOOK = createProfileBook(RULES);

function overlap(a: ResolvedBand, b: ResolvedBand): number {
  return Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0);
}

function boxOverlap(a: { x: number; y: number; w: number; d: number }, b: { x: number; y: number; w: number; d: number }): number {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.d, b.y + b.d) - Math.max(a.y, b.y);
  return Math.min(ox, oy);
}

// ---------------------------------------------------------------------------------------------------------------
// #1 — every profile, stacked against every plausible storey, resolves to ordered disjoint bands
// ---------------------------------------------------------------------------------------------------------------

test('#1 profiles stack into ordered, pairwise disjoint bands that hold the clear height', () => {
  for (const profile of BOOK.all()) {
    for (const floorToFloor of F2F) {
      for (const slabTAbove of SLAB) {
        for (const beamDAbove of BEAM) {
          const where = `${profile.id} f2f ${floorToFloor} slab ${slabTAbove} beam ${beamDAbove}`;
          const { resolved, raiseFloorToFloorTo } = stackProfile({
            profile, storey: 'L02', floorToFloor, slabTAbove,
            beamDAbove, beamDAboveUnit: beamDAbove, transferZoneDepth: 0, rules: RULES,
          });

          assert.ok(resolved.soffitZ <= floorToFloor + TOL, `${where}: soffit above the slab`);
          assert.equal(Number((floorToFloor - slabTAbove).toFixed(9)), Number(resolved.soffitZ.toFixed(9)), `${where}: soffitZ`);

          const live = resolved.bands.filter(b => !b.dropped && b.z1 - b.z0 > TOL);
          for (const b of live) {
            assert.ok(b.z0 <= b.z1 + TOL, `${where}: band ${b.id} is inverted`);
            assert.ok(b.z0 >= -TOL, `${where}: band ${b.id} goes below the floor (${b.z0})`);
          }
          for (let i = 0; i < live.length; i++) {
            for (let j = i + 1; j < live.length; j++) {
              assert.ok(overlap(live[i], live[j]) <= 1e-6,
                `${where}: bands ${live[i].id} [${live[i].z0}, ${live[i].z1}] and ${live[j].id} [${live[j].z0}, ${live[j].z1}] overlap`);
            }
          }

          // Bands are declared soffit-downward: the hanging stack must be monotonically descending.
          const hanging = live.filter(b => b.cls !== 'equipment' && b.cls !== 'clear' && b.purpose !== 'gravity-drain');
          if (profile.id !== 'roof-plant') {
            for (let i = 1; i < hanging.length; i++) {
              assert.ok(hanging[i].z1 <= hanging[i - 1].z0 + 1e-6,
                `${where}: band ${hanging[i].id} is not below ${hanging[i - 1].id}`);
            }
            for (const b of hanging.filter(x => x.cls !== 'structure')) {
              assert.ok(b.z1 <= resolved.structureBottomZ + 1e-6,
                `${where}: band ${b.id} (top ${b.z1.toFixed(3)}) is inside the structural depth (soffit bottom ${resolved.structureBottomZ.toFixed(3)})`);
              assert.ok(b.z0 >= resolved.clearZ - 1e-6,
                `${where}: band ${b.id} (bottom ${b.z0.toFixed(3)}) hangs into the clear zone (${resolved.clearZ.toFixed(3)})`);
            }
          }

          if (raiseFloorToFloorTo === null) {
            assert.ok(resolved.clearZ >= profile.clearHeight.min - 1e-6,
              `${where}: clear height ${resolved.clearZ.toFixed(3)} is below the ${profile.clearHeight.min} m minimum with no raise requested`);
          } else {
            assert.ok(raiseFloorToFloorTo > floorToFloor, `${where}: a raise must be taller than the storey it replaces`);
          }
        }
      }
    }
  }
});

test('#1b the corridor ceiling is an output: a 3.05 m flat-slab storey lands at or above the 2.10 m minimum', () => {
  const { resolved, raiseFloorToFloorTo } = stackProfile({
    profile: BOOK.profile('resi-corridor'), storey: 'L02', floorToFloor: 3.05, slabTAbove: 0.2,
    beamDAbove: 0, beamDAboveUnit: 0, transferZoneDepth: 0, rules: RULES,
  });
  assert.equal(raiseFloorToFloorTo, null);
  assert.ok(resolved.ceilingZ >= 2.1 - 1e-6, `corridor ceiling ${resolved.ceilingZ}`);
  assert.ok(resolved.ceilingZ <= 2.45, `corridor ceiling ${resolved.ceilingZ} should be compressed toward the minimum`);
  const service = resolved.bandById('resi-corridor/service');
  assert.ok(service && service.compressedBy > 0, 'the service band is the first to be compressed (flexibility 3)');
});

test('#1c a profile that cannot fit compresses, then drops, then asks for a taller storey', () => {
  const tight = stackProfile({
    profile: BOOK.profile('parking'), storey: 'B1', floorToFloor: 2.6, slabTAbove: 0.3,
    beamDAbove: 0.4, beamDAboveUnit: 0.4, transferZoneDepth: 0, rules: RULES,
  });
  const dropped = tight.resolved.bands.filter(b => b.dropped);
  assert.ok(dropped.length > 0, 'the droppable bands go before the storey is raised');
  assert.ok(tight.resolved.issues.some(i => i.resolution?.id === 'compress-band'), 'compression is recorded');
  assert.ok(tight.resolved.issues.some(i => i.resolution?.id === 'drop-band'), 'dropping is recorded');
  const roomy = stackProfile({
    profile: BOOK.profile('parking'), storey: 'B1', floorToFloor: 4.2, slabTAbove: 0.25,
    beamDAbove: 0, beamDAboveUnit: 0, transferZoneDepth: 0, rules: RULES,
  });
  assert.equal(roomy.raiseFloorToFloorTo, null);
  assert.equal(roomy.resolved.bands.filter(b => b.dropped).length, 0, 'a tall car park keeps every band');
});

test('#1d every profile is reachable from a floor use and carries sourced rationale on every band', () => {
  const ids = new Set<ProfileId>();
  for (const use of ['residential', 'lobby-residential', 'retail', 'parking', 'amenity', 'mechanical', 'roof', 'basement'] as const) {
    ids.add(BOOK.resolve(use));
  }
  ids.add(BOOK.resolve('residential', 'corridor'));
  assert.equal(ids.size, 9, `every one of the nine profiles is reachable: got ${[...ids].sort().join(', ')}`);
  for (const p of BOOK.all()) {
    assert.ok(p.clearHeight.source.length > 0, `${p.id} clear height has no source`);
    for (const b of p.bands) {
      assert.ok(b.rationale.length > 20, `${p.id}/${b.purpose} has no rationale`);
      assert.ok(b.source.length > 0, `${p.id}/${b.purpose} has no source`);
    }
    for (const e of p.elsewhere) {
      assert.ok(e.why.length > 10 && e.source.length > 0, `${p.id} elsewhere ${e.kind} is unsourced`);
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------
// #2 — the v1 shim (deleted in wave 3)
// ---------------------------------------------------------------------------------------------------------------

test('#2 plenumBands reproduces the pre-migration band heights within 1 mm', () => {
  // The four preset geometries: mid-rise flat slab, tower flat slab, podium with beams, walk-up.
  const cases: [number, number, number, number][] = [
    [3.05, 0.2, 0, 2.5],
    [3.2, 0.25, 0, 2.6],
    [4.5, 0.3, 0.5, 3.2],
    [2.9, 0.2, 0.3, 2.4],
  ];
  for (const [f2f, slabT, beamD, ceiling] of cases) {
    const v1SoffitZ = f2f - slabT;
    const v1StructureBottom = v1SoffitZ - beamD;
    const v1DuctZ = Math.max(v1StructureBottom - 0.05 - 0.15, ceiling + 0.15);
    const v1PipeZ = Math.max(v1DuctZ - 0.25, ceiling + 0.05);
    const b = plenumBands(f2f, slabT, beamD, ceiling);
    const where = `f2f ${f2f} slab ${slabT} beam ${beamD} ceiling ${ceiling}`;
    assert.ok(Math.abs(b.soffitZ - v1SoffitZ) < 0.001, `${where}: soffitZ ${b.soffitZ} vs ${v1SoffitZ}`);
    assert.ok(Math.abs(b.ductZ - v1DuctZ) < 0.001, `${where}: ductZ ${b.ductZ} vs ${v1DuctZ}`);
    assert.ok(Math.abs(b.pipeZ - v1PipeZ) < 0.001, `${where}: pipeZ ${b.pipeZ} vs ${v1PipeZ}`);
    assert.ok(Math.abs(b.sprinklerZ - v1PipeZ) < 0.001, `${where}: sprinklerZ ${b.sprinklerZ} vs ${v1PipeZ}`);
    assert.ok(Math.abs(b.trayZ - v1PipeZ) < 0.001, `${where}: trayZ ${b.trayZ} vs ${v1PipeZ}`);
    assert.equal(b.ceilingZ, ceiling, `${where}: the v1 shim takes the ceiling as an input`);
    assert.ok(Math.abs(b.plenumDepth - (f2f - ceiling)) < 1e-9, `${where}: plenumDepth`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// #3 — lanes
// ---------------------------------------------------------------------------------------------------------------

test('#3 lanes inside one band are laterally disjoint and fit the corridor', () => {
  for (const width of [1.2, 1.5, 1.7, 2.4]) {
    for (const profileId of ['resi-corridor', 'lobby', 'amenity', 'parking', 'retail-shell'] as ProfileId[]) {
      const { set } = laneSetFor(profileId, width, RULES);
      if (set.lanes.length === 0) continue;
      const where = `${profileId} at ${width} m`;
      const byBand = new Map<string, typeof set.lanes[number][]>();
      for (const l of set.lanes) {
        const list = byBand.get(l.bandPurpose) ?? [];
        list.push(l);
        byBand.set(l.bandPurpose, list);
      }
      for (const [bandPurpose, lanes] of byBand) {
        const spans = lanes.map(l => ({ id: l.id, a: l.offset - l.width / 2, b: l.offset + l.width / 2 })).sort((x, y) => x.a - y.a);
        for (let i = 1; i < spans.length; i++) {
          assert.ok(spans[i].a >= spans[i - 1].b - 1e-9,
            `${where}: lanes ${spans[i - 1].id} and ${spans[i].id} overlap in band ${bandPurpose}`);
        }
        const total = lanes.reduce((s, l) => s + l.width, 0);
        assert.ok(total <= Math.max(width, set.requiredCorridorWidth) + 1e-9,
          `${where}: band ${bandPurpose} lanes total ${total.toFixed(2)} m`);
      }
      assert.ok(set.requiredCorridorWidth <= Math.max(width, requiredWidthOf(set.lanes)) + 1e-9, `${where}: required width`);
    }
  }
});

test('#3b a narrow corridor degrades without overlap and records the squeeze', () => {
  const nominal = laneSetFor('resi-corridor', 1.7, RULES);
  const narrow = laneSetFor('resi-corridor', 1.5, RULES);
  assert.ok(narrow.issues.length > 0, 'scaling a lane set is recorded as an issue');
  assert.ok(narrow.set.requiredCorridorWidth < nominal.set.requiredCorridorWidth + 1e-9);
  for (const l of narrow.set.lanes) {
    const same = nominal.set.lanes.find(x => x.id === l.id);
    assert.ok(same && Math.abs(l.offset) <= Math.abs(same.offset) + 1e-9, `lane ${l.id} moved outward when the corridor narrowed`);
    assert.ok(l.width >= l.minWidth - 1e-9, `lane ${l.id} went below its minimum width`);
  }
  assert.equal(narrow.set.overflowLaneId, 'pressure');
});

test('#3c the lateral allocator is idempotent and independent of claim order', () => {
  const lane = laneSetFor('resi-corridor', 1.7, RULES).set.lanes.find(l => l.id === 'pressure');
  assert.ok(lane);
  const keys = ['dcw', 'dhw', 'hwr', 'gas'];
  const forward = new LateralAllocator(lane);
  const first = keys.map(k => forward.claim(k, 0.08));
  const again = keys.map(k => forward.claim(k, 0.08));
  assert.deepEqual(again, first, 'claiming twice returns the same span');
  const backward = new LateralAllocator(lane);
  const reversed = [...keys].reverse().map(k => backward.claim(k, 0.08)).reverse();
  assert.deepEqual(reversed, first, 'the span depends on the canonical system order, not the call order');
  const spans = first.map(x => x as { a: number; b: number }).sort((x, y) => x.a - y.a);
  for (let i = 1; i < spans.length; i++) {
    assert.ok(spans[i].a >= spans[i - 1].b - 1e-9, `claims ${i - 1} and ${i} overlap: ${JSON.stringify(spans)}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Kernel fixture
// ---------------------------------------------------------------------------------------------------------------

function sizing(storey: string, index: number, use: StoreySizing['use'], profileId: ProfileId): StoreySizing {
  const floorToFloor = 3.05;
  const slabTAbove = 0.25;
  return {
    storey, index, use, profileId, floorToFloor, slabTAbove,
    beamDAbove: 0, beamDAboveUnit: 0,
    soffitZ: floorToFloor - slabTAbove, corridorSoffitZ: floorToFloor - slabTAbove,
    ceilingZ: 2.5, corridorCeilingZ: 2.2,
    isTransferBelow: false, transferZoneDepth: 0, slabTOwn: 0.25,
  };
}

function makeFixture(o?: { shafts?: ShaftDef[] }): {
  storeys: StoreyDef[];
  presize: StructuralPresize;
  arch: ArchModel;
  site: SiteModel;
} {
  const storeys: StoreyDef[] = [
    { id: 'L01', name: 'Ground', index: 0, elevation: 0, height: 3.05, use: 'lobby-residential' },
    { id: 'L02', name: 'Level 2', index: 1, elevation: 3.05, height: 3.05, use: 'residential' },
    { id: 'L03', name: 'Level 3', index: 2, elevation: 6.1, height: 3.05, use: 'residential' },
  ];
  const byStorey = new Map<string, StoreySizing>([
    ['L01', sizing('L01', 0, 'lobby-residential', 'lobby')],
    ['L02', sizing('L02', 1, 'residential', 'resi-corridor')],
    ['L03', sizing('L03', 2, 'residential', 'resi-corridor')],
  ]);
  const presize: StructuralPresize = {
    system: 'rc-flat-slab',
    foundation: 'raft',
    loads: { deadKpa: 5, liveKpa: 2, roofLiveKpa: 1, liveCorridorKpa: 4 },
    sizes: { columnW: 0.4, columnD: 0.4, beamW: 0.3, beamD: 0.5, slabT: 0.25, shearWallT: 0.25 },
    columnBand: { min: 6, max: 9 },
    coreWallT: 0.25, shearWallT: 0.25, partyWallT: 0.25, exteriorWallT: 0.3, corridorWallT: 0.2,
    storeys: [...byStorey.values()],
    byStorey,
    storeysResolved: storeys,
    transferStorey: null, transferBelowStorey: null,
    transferSlabT: 0.3, transferBeamD: 0.9, transferZoneDepth: 1.2, podiumStoreys: 0,
    gridProposal: {
      longAxis: 'x', bay: { min: 6, target: 8, max: 9, source: 'test' },
      transverse: [], longitudinal: [], parkingModule: { along: 8.4, across: 16.8 }, snapTolerance: 0.15,
    },
    issues: [],
  };
  const shafts: ShaftDef[] = o?.shafts ?? [
    { id: 'SH-1', rect: { x: 10, y: 4, w: 2.4, h: 1.2 }, storeys: ['L01', 'L02', 'L03'], purpose: 'combined', servesUnitIds: [], accessFrom: 'corridor' },
    { id: 'SH-2', rect: { x: 20, y: 4, w: 1.2, h: 1.2 }, storeys: ['L02', 'L03'], purpose: 'plumbing', servesUnitIds: [], accessFrom: 'unit' },
    { id: 'LIFT-1', rect: { x: 30, y: 4, w: 2.2, h: 2.4 }, storeys: ['L01', 'L02', 'L03'], purpose: 'elevator', servesUnitIds: [], accessFrom: 'core' },
  ];
  const arch = {
    storeys, floors: storeys.map(s => ({
      storey: s.id, use: s.use === 'lobby-residential' ? 'lobby-residential' : 'residential', outline: [], area: 600,
      floorToFloor: 3.05, ceilingHeight: 2.5, slabThickness: 0.25,
      corridors: [{ id: `C-${s.id}`, storey: s.id, polygon: [], centerline: [{ a: [0, 13], b: [40, 13] }], width: 1.7, roomId: `R-${s.id}` }],
      unitIds: [], roomIds: [], commonRoomIds: [], wallIds: [], exteriorWallIds: [], balconies: [], wwr: 0.3,
    })),
    units: [], rooms: [], walls: [], doors: [], windows: [], furniture: [], cores: [], stairs: [], elevators: [],
    shafts, roof: { type: 'flat', outline: [], thickness: 0.25, pitchRad: 0, ridgeAxis: 'x', parapetHeight: 1.1 },
    templatesUsed: [], elements: [], patterns: [], derived: {},
  } as unknown as ArchModel;
  const site = { massing: { corridors: [{ id: 'S1', barId: 'B1', centerline: { a: [0, 13], b: [40, 13] }, width: 1.7, loaded: 'both' }], storeys } } as unknown as SiteModel;
  return { storeys, presize, arch, site };
}

function makeKernel(o?: { shafts?: ShaftDef[] }) {
  const f = makeFixture(o);
  const ledger = createLedger();
  const kernel = createKernel({
    storeys: f.storeys, presize: f.presize, profiles: BOOK, rules: RULES, ledger, arch: f.arch, site: f.site,
  });
  return { kernel, ledger, ...f };
}

// ---------------------------------------------------------------------------------------------------------------
// #4 — shaft slots
// ---------------------------------------------------------------------------------------------------------------

const RISERS: { system: ShaftSystem; discipline: 'plumbing' | 'mechanical' | 'electrical'; w: number; d: number }[] = [
  { system: 'waste', discipline: 'plumbing', w: 0.16, d: 0.16 },
  { system: 'vent', discipline: 'plumbing', w: 0.1, d: 0.1 },
  { system: 'dcw', discipline: 'plumbing', w: 0.1, d: 0.1 },
  { system: 'dhw', discipline: 'plumbing', w: 0.09, d: 0.09 },
  { system: 'air-supply', discipline: 'mechanical', w: 0.45, d: 0.45 },
  { system: 'air-exhaust', discipline: 'mechanical', w: 0.4, d: 0.4 },
  { system: 'power', discipline: 'electrical', w: 0.3, d: 0.2 },
  { system: 'data', discipline: 'electrical', w: 0.2, d: 0.15 },
];

test('#4 shaft slots are disjoint, idempotent and independent of request order', () => {
  const a = makeKernel();
  const storeys = ['L02', 'L03'];
  for (const r of RISERS) {
    const slot = a.kernel.shafts.slot({ shaftId: 'SH-1', discipline: r.discipline, system: r.system, w: r.w, d: r.d, storeys });
    assert.ok(!isConflict(slot), `${r.system}: ${isConflict(slot) ? slot.message : ''}`);
  }
  const slots = a.kernel.shafts.slotsOf('SH-1');
  assert.equal(slots.length, RISERS.length);
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      const bi = { x: slots[i].xy[0] - slots[i].w / 2, y: slots[i].xy[1] - slots[i].d / 2, w: slots[i].w, d: slots[i].d };
      const bj = { x: slots[j].xy[0] - slots[j].w / 2, y: slots[j].xy[1] - slots[j].d / 2, w: slots[j].w, d: slots[j].d };
      assert.ok(boxOverlap(bi, bj) <= 1e-9,
        `slots ${slots[i].system} and ${slots[j].system} overlap in shaft SH-1`);
    }
    assert.equal(SHAFT_ZONE_OF[slots[i].system], slots[i].zone, 'a slot is in its discipline’s zone');
  }

  // idempotent
  const again = a.kernel.shafts.slot({ shaftId: 'SH-1', discipline: 'plumbing', system: 'waste', w: 0.16, d: 0.16, storeys });
  assert.ok(!isConflict(again));
  assert.deepEqual(again.xy, slots.find(s => s.system === 'waste')?.xy);

  // order independent: shuffle with the seeded RNG
  const rng = createRng(4242);
  const shuffled = rng.shuffle(RISERS);
  const b = makeKernel();
  for (const r of shuffled) {
    b.kernel.shafts.slot({ shaftId: 'SH-1', discipline: r.discipline, system: r.system, w: r.w, d: r.d, storeys });
  }
  const bySystem = (list: readonly { system: string; xy: [number, number]; w: number; d: number }[]) =>
    JSON.stringify([...list].sort((x, y) => (x.system < y.system ? -1 : 1)).map(s => [s.system, s.xy[0].toFixed(4), s.xy[1].toFixed(4), s.w, s.d]));
  assert.equal(bySystem(b.kernel.shafts.slotsOf('SH-1')), bySystem(slots), 'shuffled request order produces identical slots');
});

test('#4b a hoistway takes no services and a full shaft reports a conflict, never throws', () => {
  const k = makeKernel();
  const lift = k.kernel.shafts.slot({ shaftId: 'LIFT-1', discipline: 'plumbing', system: 'waste', w: 0.16, d: 0.16, storeys: ['L02'] });
  assert.ok(isConflict(lift) && lift.ruleId === 'XD-04.hoistway', 'IBC 3005.3: no piping in a hoistway');
  const tiny = makeKernel({
    shafts: [{ id: 'SH-T', rect: { x: 0, y: 0, w: 0.4, h: 0.4 }, storeys: ['L02'], purpose: 'combined', servesUnitIds: [], accessFrom: 'corridor' }],
  });
  const big = tiny.kernel.shafts.slot({ shaftId: 'SH-T', discipline: 'mechanical', system: 'air-supply', w: 1.2, d: 1.2, storeys: ['L02'] });
  assert.ok(isConflict(big) && big.reason === 'shaft-full', 'an oversized riser is a conflict');
  const missing = tiny.kernel.shafts.slot({ shaftId: 'NOPE', discipline: 'plumbing', system: 'waste', w: 0.1, d: 0.1, storeys: ['L02'] });
  assert.ok(isConflict(missing) && missing.reason === 'no-shaft');
});

// ---------------------------------------------------------------------------------------------------------------
// #5 — reserve
// ---------------------------------------------------------------------------------------------------------------

test('#5 reserve refuses the wrong kind, refuses a box outside the band, and never throws', () => {
  const k = makeKernel();
  const band = k.kernel.profileOf('L02').band('service');
  assert.ok(band);
  const inside: Box3 = { x: 5, y: 12.8, z: band.z0 + 0.01, w: 2, d: 0.4, h: Math.max(0.05, band.z1 - band.z0 - 0.02) };

  const ok = k.kernel.reserve({ owner: 'mechanical', kind: 'duct', storey: 'L02', container: 'band', purpose: 'service', boxes: [inside] });
  assert.ok(!isConflict(ok), 'a duct in the service band is fine');
  assert.equal(ok.containerId, band.id);

  const wrongKind = k.kernel.reserve({ owner: 'plumbing', kind: 'waste', storey: 'L02', container: 'band', purpose: 'sprinkler', boxes: [inside] });
  assert.ok(isConflict(wrongKind) && wrongKind.reason === 'kind-not-allowed' && wrongKind.ruleId === 'XD-02.bandAllows');

  const outside = k.kernel.reserve({
    owner: 'mechanical', kind: 'duct', storey: 'L02', container: 'band', purpose: 'service',
    boxes: [{ ...inside, z: band.z1 + 0.5 }],
  });
  assert.ok(isConflict(outside) && outside.reason === 'outside-band' && (outside.suggestion?.length ?? 0) > 0,
    'an out-of-band box is a conflict with a suggestion');

  const noBand = k.kernel.reserve({ owner: 'mechanical', kind: 'jet-fan', storey: 'L02', container: 'band', purpose: 'duct', boxes: [inside] });
  assert.ok(isConflict(noBand) && noBand.reason === 'no-band');

  // a lane that cannot hold the run is a conflict, not an exception
  const centerline = [{ a: [0, 13] as [number, number], b: [40, 13] as [number, number] }];
  const run = k.kernel.reserveLaneRun({
    owner: 'mechanical', kind: 'duct', storey: 'L02', laneId: 'duct', centerline, width: 0.6, height: 0.3, systemKey: 'supply',
  });
  assert.ok(!isConflict(run), 'the duct lane takes the supply trunk');
  assert.ok(run.width <= 0.6 + 1e-9 && run.path.length === 2);
  const noLane = k.kernel.reserveLaneRun({
    owner: 'mechanical', kind: 'duct', storey: 'L02', laneId: 'nope', centerline, width: 0.6, height: 0.3, systemKey: 'supply',
  });
  assert.ok(isConflict(noLane) && noLane.ruleId === 'XD-02.laneWidth');
});

test('#5b a keep-out bans the kinds it lists and admits the rest', () => {
  const k = makeKernel();
  const profile = k.kernel.profileOf('L02');
  const band = profile.band('service');
  assert.ok(band);
  const box: Box3 = { x: 2, y: 12.9, z: band.z0, w: 1, d: 0.3, h: band.z1 - band.z0 };
  k.kernel.keepOut({
    owner: 'electrical', kind: 'switchgear', storey: 'L02', boxes: [{ x: 1.5, y: 12.5, z: 0, w: 2, d: 1, h: 1.8 }],
    bans: ['waste', 'vent', 'storm', 'dcw', 'dhw', 'hwr', 'gas', 'duct'],
    note: 'NEC 2023 110.26(E)(1)(b) dedicated space',
  });
  // NEC 110.26(E) reserves floor → 1.80 m above the equipment, so the offending service is one dropping down the
  // wall beside the switchgear, not a run in the plenum above it (which (E)(1)(b) permits with drip protection).
  const banned = k.kernel.reserve({
    owner: 'plumbing', kind: 'dcw', storey: 'L02', container: 'wall', containerId: 'W-ELEC',
    boxes: [{ x: 2, y: 12.9, z: 0.4, w: 0.1, d: 0.1, h: 0.8 }],
  });
  assert.ok(isConflict(banned) && banned.reason === 'keepout' && banned.ruleId === 'ELE-13.dedicatedSpace');
  const allowed = k.kernel.reserve({ owner: 'plumbing', kind: 'sprinkler-branch', storey: 'L02', container: 'band', purpose: 'sprinkler', boxes: [{ ...box, z: (profile.band('sprinkler') as ResolvedBand).z0, h: 0.05 }] });
  assert.ok(!isConflict(allowed), 'NEC 110.26(E)(1)(c): sprinkler protection is permitted with drip protection');
});

// ---------------------------------------------------------------------------------------------------------------
// #6 — crossings
// ---------------------------------------------------------------------------------------------------------------

test('#6 forty branches asking for the same crossing station get forty disjoint stations', () => {
  const k = makeKernel();
  const centerline = [{ a: [0, 13] as [number, number], b: [40, 13] as [number, number] }];
  const spans: { a: number; b: number; key: string }[] = [];
  for (let n = 0; n < 40; n++) {
    const c = k.kernel.reserveCrossing({
      owner: 'plumbing', kind: 'waste', storey: 'L02', centerline, station: 20, length: 2.0,
      width: 0.14, height: 0.15, systemKey: `branch-${n}`, slope: 0.01,
    });
    assert.ok(!isConflict(c), `branch ${n}: ${isConflict(c) ? c.message : ''}`);
    const x = c.path[0][0];
    spans.push({ a: x - 0.15, b: x + 0.15, key: `branch-${n}` });
    assert.ok(c.path[0][2] >= c.path[1][2] - 1e-9, 'a sloped crossing falls in the direction of flow');
  }
  spans.sort((x, y) => x.a - y.a);
  for (let i = 1; i < spans.length; i++) {
    assert.ok(spans[i].a >= spans[i - 1].b - 1e-9, `crossings ${spans[i - 1].key} and ${spans[i].key} share a station`);
  }
  const distinct = new Set(spans.map(s => s.a.toFixed(4)));
  assert.equal(distinct.size, 40, 'every crossing has its own station');
});

test('#6b the station allocator walks outward deterministically and is idempotent', () => {
  const alloc = new StationAllocator('band', 0.3);
  const first = alloc.claim('a', 10, 0.2);
  const second = alloc.claim('b', 10, 0.2);
  const third = alloc.claim('c', 10, 0.2);
  assert.deepEqual(first, { station: 10, shifted: 0 });
  assert.ok(second && third && second.station !== third.station);
  assert.deepEqual(alloc.claim('b', 10, 0.2), second, 'claiming twice returns the same station');
  const mirror = new StationAllocator('band', 0.3);
  assert.deepEqual(mirror.claim('a', 10, 0.2), first, 'a fresh allocator gives the same answer');
});

// ---------------------------------------------------------------------------------------------------------------
// #7 — determinism
// ---------------------------------------------------------------------------------------------------------------

test('#7 two kernels built from the same inputs produce identical reservations', () => {
  const run = (): string => {
    const k = makeKernel();
    const centerline = [{ a: [0, 13] as [number, number], b: [40, 13] as [number, number] }];
    for (const r of RISERS) {
      k.kernel.reserveRiser({ owner: r.discipline, kind: 'duct', system: r.system, shaftId: 'SH-1', storeys: ['L02', 'L03'], w: r.w, d: r.d });
    }
    k.kernel.reserveLaneRun({ owner: 'mechanical', kind: 'duct', storey: 'L02', laneId: 'duct', centerline, width: 0.5, height: 0.3, systemKey: 'supply' });
    k.kernel.reserveLaneRun({ owner: 'plumbing', kind: 'dcw', storey: 'L02', laneId: 'pressure', centerline, width: 0.1, height: 0.1, systemKey: 'dcw' });
    k.kernel.reserveCrossing({ owner: 'plumbing', kind: 'waste', storey: 'L02', centerline, station: 12, length: 2, width: 0.14, height: 0.15, systemKey: 'u1' });
    k.kernel.chase({
      unitId: 'U-L02-01', storeys: ['L02', 'L03'], wallId: 'W1', wall: { a: [4, 10], b: [4, 16] }, wallThickness: 0.2,
      station: 3, systems: ['waste', 'vent', 'dcw', 'dhw'],
    });
    k.kernel.sleeve({ storey: 'L02', hostKind: 'slab', hostId: 'SLAB-L02', at: [4, 13], z: 0, outsideDiameter: 0.11, system: 'waste' });
    k.kernel.keepOut({ owner: 'structure', kind: 'beam', storey: 'L02', boxes: [{ x: 0, y: 12.8, z: 2.3, w: 40, d: 0.4, h: 0.5 }], bans: ['duct', 'waste'], note: 'beam' });
    return JSON.stringify(k.kernel.reservations());
  };
  assert.equal(run(), run());
});

test('#7b the kernel reports what it did', () => {
  const k = makeKernel();
  const centerline = [{ a: [0, 13] as [number, number], b: [40, 13] as [number, number] }];
  k.kernel.reserveLaneRun({ owner: 'mechanical', kind: 'duct', storey: 'L02', laneId: 'duct', centerline, width: 0.5, height: 0.3, systemKey: 'supply' });
  k.kernel.reserveRiser({ owner: 'plumbing', kind: 'waste', system: 'waste', near: [10, 4], storeys: ['L02', 'L03'], w: 0.16, d: 0.16 });
  const chase = k.kernel.chase({
    unitId: 'U-L02-01', storeys: ['L02'], wallId: 'W1', wall: { a: [4, 10], b: [4, 16] }, wallThickness: 0.2,
    station: 3, systems: ['waste', 'vent', 'dcw', 'dhw'],
  });
  assert.ok(!isConflict(chase));
  assert.equal(k.kernel.chaseOf('U-L02-01')?.id, chase.id, 'a dwelling has exactly one chase');
  // waste sits in the middle of the chase: it is what the trap arms are measured to
  const wasteXY = chase.systemXY.get('waste');
  assert.ok(wasteXY && Math.abs(wasteXY[0] - chase.xy[0]) < 1e-9 && Math.abs(wasteXY[1] - chase.xy[1]) < 1e-9);
  const derived = k.kernel.derived();
  assert.equal(derived.laneRuns, 1);
  assert.equal(derived.chases, 1);
  assert.ok(derived.shaftSlots >= 1 && derived.reservations >= 3);
  assert.equal(derived.conflicts, 0);
});

test('#7c every profile id in the book is stackable from the fixture presize', () => {
  const k = makeKernel();
  for (const s of ['L01', 'L02', 'L03']) {
    const p = k.kernel.profileOf(s);
    assert.ok(p.bands.length > 0, `${s} has no bands`);
    assert.ok(p.clearZ > 1.9, `${s} clear height ${p.clearZ}`);
    assert.equal(p.storey, s);
  }
  assert.equal(k.kernel.profileOf('L02', 'bathroom').profileId, 'resi-unit', 'a room type picks the dwelling profile');
  assert.equal(k.kernel.profileOf('L02', 'corridor').profileId, 'resi-corridor');
  assert.ok(PROFILE_DEFS.length === 9);
  assert.equal(EMPTY_RULE_SET.num('anything', 42), 42, 'the fallback rule set returns the caller’s default');
  assert.equal(SHAFT_SYSTEM_ORDER.length, 21);
});
