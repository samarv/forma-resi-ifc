/**
 * PLUMBING + FIRE PROTECTION discipline.
 *
 * generatePlumbing(ctx) → PlumbModel
 *   1. fixtures        from architecture furniture flagged needsWater (+ synthesised bathrooms)
 *   2. stacks          one per DWELLING column, vertical through its storeys, vent to roof PLB-01/02/03
 *   3. branches        trap arms at z -0.12, supply at z 0.45/0.55, vents at z 1.5   PLB-02/03
 *   4. hot water       per-unit tanks / tankless / central plant + HWR loop          PLB-04
 *   5. cold service    street → meter → backflow → booster → corridor lane / bar trunk PLB-07/08/11/12
 *   6. fire            sprinklers, straight branch lines, corridor mains, standpipes PLB-05/10
 *   7. storm           roof drains, downpipes at cores/shafts, buried main           PLB-06
 *   8. gas             optional, minimal (detail 'high' only)
 *
 * Z conventions and the shaft-corner convention are documented in state.ts / storm.ts.
 * EVERY horizontal run is Manhattan and bounded in points/length — see routing.ts.
 */
import type { DhwSystemId, GenContext, PipeSystemType, PlumbModel, PlumbingStack } from '../../core/types.ts';
import { round } from '../../core/geometry.ts';
import { PLUMB_PATTERNS } from './patterns.ts';
import { createState, pathLength, warn, type PlumbState } from './state.ts';
import { buildFixtures, buildFloorDrains, buildHoseBibbs } from './fixtures.ts';
import { buildStacks } from './stacks.ts';
import { buildBranches } from './branches.ts';
import { buildDhw } from './dhw.ts';
import { buildService } from './service.ts';
import { buildFireProtection } from './sprinkler.ts';
import { buildStorm, buildGas } from './storm.ts';

export { PLUMB_PATTERNS };
export { plumbingShaftCorner } from './storm.ts';
export { headGrid, sprinklersRequired } from './sprinkler.ts';
export {
  WASTE_Z, DCW_BRANCH_Z, DHW_BRANCH_Z, BRANCH_VENT_Z, SERVICE_Z, STORM_MAIN_Z, BUILDING_DRAIN_Z, SEWER_Z,
} from './state.ts';

const ALL_SYSTEMS: PipeSystemType[] = ['dcw', 'dhw', 'hwr', 'waste', 'vent', 'storm', 'sprinkler', 'standpipe', 'gas'];

export function generatePlumbing(ctx: GenContext): PlumbModel {
  const st = createState(ctx);
  const dhw: DhwSystemId = ctx.typology.dhw;

  if (!ctx.arch) {
    warn(st, 'noarch', 'no architecture model available; plumbing skipped');
    return emptyModel(dhw);
  }

  const placed = buildFixtures(st);
  buildFloorDrains(st);
  buildHoseBibbs(st);
  buildStacks(st, placed);
  buildBranches(st, placed);
  const dhwRes = buildDhw(st);
  const svc = buildService(st, dhwRes.corridorSystems);
  const fire = buildFireProtection(st);
  const storm = buildStorm(st);
  buildGas(st);

  // --- cross-discipline pattern trace --------------------------------------
  const unitWalls = new Map<string, Set<string>>();
  for (const p of placed) {
    if (!p.unitId) continue;
    const s = unitWalls.get(p.unitId) ?? new Set<string>();
    s.add(p.wallId);
    unitWalls.set(p.unitId, s);
  }
  let shared = 0;
  for (const s of unitWalls.values()) if (s.size === 1) shared++;
  st.apps.push({
    patternId: 'PLB-09',
    params: {
      dwellingsChecked: unitWalls.size,
      dwellingsOnOneWetWall: shared,
      dwellingsOnMultipleWalls: unitWalls.size - shared,
      wetWallThickness: 0.2,
    },
    note: unitWalls.size > 0 && shared < unitWalls.size
      ? 'some dwellings have fixtures on more than one wall — architecture could consolidate onto one wet wall (XD-01)'
      : 'every dwelling drains to a single wet wall',
  });
  if (st.stacks.length > 0) {
    st.apps.push({
      patternId: 'XD-01',
      params: {
        stacks: st.stacks.length,
        dwellings: ctx.arch.units.length,
        stacksPerDwelling: round(st.stacks.length / Math.max(1, ctx.arch.units.length), 3),
        alignTolerance: 0.3,
        maxFixtureDistanceToStack: 3.0,
      },
    });
  }
  if ((st.counts.mains ?? 0) > 0) {
    st.apps.push({
      patternId: 'XD-02',
      params: { pipeLaneOffset: -0.35, sprinklerLaneOffset: -0.15, mains: st.counts.mains ?? 0 },
    });
  }

  // --- totals + derived ----------------------------------------------------
  const dfu = st.fixtures.reduce((s, f) => s + f.dfu, 0);
  const wsfu = st.fixtures.reduce((s, f) => s + f.wsfu, 0);
  const occupants = ctx.arch.units.reduce((s, u) => s + (u.occupants || 0), 0)
    || ctx.arch.rooms.reduce((s, r) => s + (r.occupancy || 0), 0);

  const derived: Record<string, number> = {
    dfu: round(dfu, 1),
    wsfu: round(wsfu, 1),
    fixtureCount: st.fixtures.length,
    serviceDiameter: svc.serviceDiameter,
    peakFlowLps: round(svc.peakFlowLps, 3),
    stackCount: st.stacks.length,
    stacksPerDwelling: round(st.stacks.length / Math.max(1, ctx.arch.units.length), 3),
    secondaryStacks: st.stacks.filter(s => s.secondary).length,
    trapArmSplits: st.counts.trapArmSplits ?? 0,
    ventedBranchDrains: st.counts.ventedBranchDrains ?? 0,
    multiWallDwellings: st.counts.multiWallDwellings ?? 0,
    sanitaryFixtures: st.fixtures.filter(f =>
      f.type !== 'sprinkler-head' && f.type !== 'fire-hose-valve' && f.type !== 'roof-drain'
      && f.type !== 'water-meter' && f.type !== 'backflow-preventer' && f.type !== 'booster-pump').length,
    sprinklerHeads: fire.heads,
    standpipes: fire.standpipes,
    hoseValves: fire.hoseValves,
    hoseBibbs: st.counts.hoseBibbs ?? 0,
    floorDrains: st.counts.floorDrains ?? 0,
    roofDrains: storm.roofDrains.length,
    downpipes: storm.downpipes,
    waterHeaters: st.counts.waterHeaters ?? 0,
    dhwStorageL: dhwRes.storageL,
    waterDemandLPerDay: round(occupants * 150, 0),
    occupants,
    boosterPumps: st.counts.boosters ?? 0,
    pipeRuns: st.pipes.length,
    pipeFittings: st.counts.fittings ?? 0,
    /** Runs split because they hit the point / length cap (PLB-11) */
    runSplits: st.counts.runSplits ?? 0,
    /** Self-check: emitted pipe segments that are not axis-parallel (must be 0) */
    nonOrthogonalSegments: st.counts.nonOrthogonal ?? 0,
    maxRunPoints: st.pipes.reduce((m, p) => Math.max(m, p.path.length), 0),
    maxRunLength: round(st.pipes.reduce((m, p) => Math.max(m, pathLength(p.path)), 0), 2),
    elementCount: st.elements.length,
    wasteBranches: st.counts.wasteBranches ?? 0,
    supplyBranches: st.counts.supplyBranches ?? 0,
    ventBranches: st.counts.ventBranches ?? 0,
    unpipedFixtures: st.counts.unpipedFixtures ?? 0,
  };
  let total = 0;
  for (const sys of ALL_SYSTEMS) {
    const l = st.pipeLength.get(sys) ?? 0;
    derived[`pipeLength.${sys}`] = round(l, 2);
    total += l;
  }
  derived.pipeLengthTotal = round(total, 2);

  return {
    dhw,
    sprinklered: fire.active,
    fixtures: st.fixtures,
    stacks: st.stacks.map(s => s.stack),
    pipes: st.pipes,
    roofDrains: storm.roofDrains,
    totals: {
      dfu: round(dfu, 1),
      wsfu: round(wsfu, 1),
      fixtureCount: st.fixtures.length,
      serviceDiameter: svc.serviceDiameter,
    },
    elements: st.elements,
    patterns: st.apps,
    derived,
  };
}

function emptyModel(dhw: DhwSystemId): PlumbModel {
  const derived: Record<string, number> = {
    dfu: 0, wsfu: 0, fixtureCount: 0, serviceDiameter: 0, stackCount: 0,
    stacksPerDwelling: 0, ventedBranchDrains: 0, multiWallDwellings: 0,
    sprinklerHeads: 0, roofDrains: 0, standpipes: 0, hoseBibbs: 0,
    waterDemandLPerDay: 0, dhwStorageL: 0, peakFlowLps: 0, elementCount: 0,
    runSplits: 0, nonOrthogonalSegments: 0, maxRunPoints: 0, maxRunLength: 0,
  };
  for (const sys of ALL_SYSTEMS) derived[`pipeLength.${sys}`] = 0;
  derived.pipeLengthTotal = 0;
  const stacks: PlumbingStack[] = [];
  return {
    dhw, sprinklered: false, fixtures: [], stacks, pipes: [], roofDrains: [],
    totals: { dfu: 0, wsfu: 0, fixtureCount: 0, serviceDiameter: 0 },
    elements: [], patterns: [], derived,
  };
}

/** Exposed for tests / tooling: the internal state builder */
export type { PlumbState };
