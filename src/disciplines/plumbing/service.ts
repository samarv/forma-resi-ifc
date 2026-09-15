/**
 * Step 5 — cold water service, horizontal mains and the building drain
 * (PLB-07 Service Entry at the Street, PLB-08 Fixture Units Size the Pipe,
 *  PLB-11 Pipes Below Ducts Beside Trays, PLB-12 Booster Above Eight Storeys).
 */
import type { ArchModel, PipeSystemType, RoomDef, Segment2, Vec2 } from '../../core/types.ts';
import { dist, rectCenter, round } from '../../core/geometry.ts';
import { DEFAULT_LANES } from '../../core/coordination.ts';
import { GPM_TO_LPS, hunterGpm, mainDiameterFor, serviceDiameterFor, SYSTEM_NAME } from './tables.ts';
import {
  addFixture, emitRun, warn, bump, info, barsOn, BUILDING_DRAIN_Z, SEWER_Z, SERVICE_Z, WASTE_Z,
  type PlumbState, type StackInfo,
} from './state.ts';
import {
  laneSpine, spineAt, spinePaths, spineStation, spineTap, streetLateral, trunkSpine,
  TRUNK_WALL_INSET, type Spine,
} from './routing.ts';
import { stackXY } from './stacks.ts';
import { findPlantRoom } from './dhw.ts';

export interface ServiceResult {
  serviceDiameter: number;
  peakFlowLps: number;
  meterRoomId?: string;
  booster: boolean;
}

/** Stacks that exist on a given storey */
function stacksOn(st: PlumbState, storey: string): StackInfo[] {
  return st.stacks.filter(si => si.storeys.includes(storey));
}

/**
 * The horizontal route a storey's mains follow.
 *
 * With corridors: one lane per corridor, offset from its centreline (XD-02 service spine).
 * Without corridors (parking, retail, lobby, a terrace of houses): ONE trunk per bar along the
 * bar's long axis, 1 m inside the exterior wall on the side nearest the risers, just under the
 * slab. Every riser then gets its own L-shaped tap — the mains never chain risers into one
 * polyline, which is what produced the zig-zags across the podium plate.
 */
export function spineFor(st: PlumbState, storey: string, anchors: Vec2[], lateral: number): Spine | null {
  const si = info(st, storey);
  if (si.hasCorridors) {
    const corridors: Segment2[][] = (si.plan?.corridors ?? [])
      .map(c => c.centerline)
      .filter(c => c.length > 0);
    const lane = laneSpine(corridors, lateral, si.bands.pipeZ);
    if (lane) return lane;
  }
  if (anchors.length === 0) return null;
  return trunkSpine(barsOn(st, storey), anchors, si.trunkZ, TRUNK_WALL_INSET);
}

/** Base height of the mains on a storey: the corridor pipe band, or the trunk height */
export function mainZ(st: PlumbState, storey: string, spine: Spine): number {
  return spine.kind === 'lane' ? info(st, storey).bands.pipeZ : info(st, storey).trunkZ;
}

export function buildService(st: PlumbState, corridorSystems: ('dhw' | 'hwr')[]): ServiceResult {
  const arch = st.ctx.arch as ArchModel;
  const totalWsfu = st.fixtures.reduce((s, f) => s + f.wsfu, 0);
  const dwellings = Math.max(1, arch.units.length);
  const serviceDiameter = serviceDiameterFor(totalWsfu, dwellings);
  const gpm = hunterGpm(totalWsfu);
  const peakFlowLps = gpm * GPM_TO_LPS;
  const aboveGrade = st.buildingStoreys.filter(s => s.index >= 0).length;
  const booster = aboveGrade > 8;
  const ground = st.groundStorey;

  // --- meter room and equipment --------------------------------------------
  const room = findPlantRoom(st, arch);
  if (!room) {
    warn(st, 'nometer', 'no ground-floor room found for the water meter; service entry omitted');
    return { serviceDiameter, peakFlowLps, booster };
  }
  const c = rectCenter(room.rect);
  const frontY = room.rect.y + Math.min(0.5, room.rect.h / 3);
  const meter: Vec2 = [Math.max(room.rect.x + 0.3, c[0] - 0.7), frontY];
  const bfp: Vec2 = [Math.min(room.rect.x + room.rect.w - 0.3, c[0] + 0.1), frontY];

  addFixture(st, {
    type: 'water-meter', storey: ground, center: [meter[0], meter[1], 0.6],
    roomId: room.id, solid: true, patterns: ['PLB-07', 'PLB-08'],
    extraProps: [
      { name: 'ServiceDiameter', value: serviceDiameter },
      { name: 'TotalWSFU', value: round(totalWsfu, 1) },
      { name: 'DesignFlowGpm', value: round(gpm, 1) },
      { name: 'DesignFlowLps', value: round(peakFlowLps, 3) },
    ],
  });
  addFixture(st, {
    type: 'backflow-preventer', storey: ground, center: [bfp[0], bfp[1], 0.6],
    roomId: room.id, solid: true, patterns: ['PLB-07'],
    extraProps: [{ name: 'Assembly', value: 'reduced-pressure principle (IPC 608.13.2)' }],
  });
  bump(st, 'meters');

  if (booster) {
    const bp: Vec2 = [c[0], Math.min(room.rect.y + room.rect.h - 0.5, frontY + 1.4)];
    addFixture(st, {
      type: 'booster-pump', storey: ground, center: [bp[0], bp[1], 0],
      roomId: room.id, solid: true, patterns: ['PLB-12'],
      extraProps: [
        { name: 'Storeys', value: aboveGrade },
        { name: 'DesignFlowLps', value: round(peakFlowLps, 3) },
        { name: 'StaticHeadKpa', value: round(aboveGrade * 30, 0) },
      ],
    });
    bump(st, 'boosters');
    st.apps.push({
      patternId: 'PLB-12',
      storey: ground,
      params: { storeys: aboveGrade, threshold: 8, staticHeadKpa: round(aboveGrade * 30, 0), designFlowLps: round(peakFlowLps, 3) },
    });
  }

  // --- buried service from the street --------------------------------------
  const streetY = st.siteBounds.y;
  emitRun(st, {
    storey: ground,
    system: 'dcw',
    diameter: serviceDiameter,
    path: [
      [meter[0], streetY, SERVICE_Z],
      [meter[0], meter[1], SERVICE_Z],
      [meter[0], meter[1], 0.6],
    ],
    name: `Water service Ø${Math.round(serviceDiameter * 1000)} (buried)`,
    roomId: room.id,
    patterns: ['PLB-07', 'PLB-08'],
    psetExtra: [
      { name: 'BurialDepth', value: Math.abs(SERVICE_Z) },
      { name: 'TotalWSFU', value: round(totalWsfu, 1) },
      { name: 'DesignFlowLps', value: round(peakFlowLps, 3) },
    ],
  });
  st.apps.push({
    patternId: 'PLB-07',
    storey: ground,
    params: {
      meterRoomId: room.id, roomType: room.type,
      serviceDiameter, burialDepth: Math.abs(SERVICE_Z), meterHeight: 0.6,
      entryX: round(meter[0], 2), streetY: round(streetY, 2), booster,
    },
  });
  st.apps.push({
    patternId: 'PLB-08',
    params: {
      totalWSFU: round(totalWsfu, 1),
      hunterGpm: round(gpm, 1),
      designVelocity: 2.4,
      serviceDiameter,
      codeFloor: dwellings > 1 ? 0.05 : 0.025,
      dwellings,
    },
  });

  // --- horizontal mains, storey by storey (PLB-11 lanes) -------------------
  const wsfuByStorey = new Map<string, number>();
  for (const f of st.fixtures) wsfuByStorey.set(f.storey, (wsfuByStorey.get(f.storey) ?? 0) + f.wsfu);

  let groundSpine: Spine | null = null;
  for (const s of st.buildingStoreys) {
    const on = stacksOn(st, s.id);
    if (on.length === 0) continue;
    const bands = info(st, s.id).bands;
    const spine = spineFor(st, s.id, on.map(si => si.stack.xy as Vec2), DEFAULT_LANES.pipe);
    if (!spine) continue;
    const baseZ = mainZ(st, s.id, spine);
    const wsfu = Math.max(wsfuByStorey.get(s.id) ?? 0, 1);
    const dcwD = Math.max(0.05, mainDiameterFor(wsfu));
    const systems: { system: PipeSystemType; d: number }[] = [{ system: 'dcw', d: dcwD }];
    for (const extra of corridorSystems) {
      systems.push({ system: extra, d: extra === 'hwr' ? 0.02 : Math.max(0.032, mainDiameterFor(wsfu * 0.6)) });
    }
    const laneNote = spine.kind === 'lane'
      ? `pipe lane ${DEFAULT_LANES.pipe} m off corridor centreline`
      : `bar trunk ${TRUNK_WALL_INSET} m inside the exterior wall (no corridor on this floor)`;
    for (const sys of systems) {
      const z = sys.system === 'dcw' ? baseZ : sys.system === 'dhw' ? baseZ - 0.12 : baseZ - 0.2;
      // one run per corridor lane / per bar trunk — never one polyline across the floor plate
      for (const path of spinePaths(spine, z)) {
        emitRun(st, {
          storey: s.id, system: sys.system, diameter: sys.d, path,
          name: `${SYSTEM_NAME[sys.system]} main Ø${Math.round(sys.d * 1000)}`,
          patterns: ['PLB-11', 'XD-02', ...(sys.system === 'dcw' ? ['PLB-08'] : ['PLB-04'])],
          psetExtra: [
            { name: 'WSFU', value: round(wsfu, 1) },
            { name: 'Lane', value: laneNote },
            { name: 'LaneZ', value: round(z, 3) },
          ],
        });
      }
      // L-shaped taps to each stack, ordered along the spine
      const feed = spine.z === z ? spine : spineAt(spine, z);
      const fed = on.filter(si => si.stack.systems.includes(sys.system));
      fed.sort((a, b) => spineStation(feed, a.stack.xy as Vec2) - spineStation(feed, b.stack.xy as Vec2)
        || a.stack.id.localeCompare(b.stack.id));
      for (const si of fed) {
        const target = stackXY(si, sys.system);
        emitRun(st, {
          storey: s.id, system: sys.system, diameter: Math.min(sys.d, si.diameters.get(sys.system) ?? sys.d),
          path: spineTap(feed, target, z),
          stackId: si.stack.id,
          name: `${SYSTEM_NAME[sys.system]} tap to stack Ø${Math.round((si.diameters.get(sys.system) ?? sys.d) * 1000)}`,
          patterns: ['PLB-11', 'PLB-01'],
        });
      }
      bump(st, 'mains');
    }
    st.apps.push({
      patternId: 'PLB-11',
      storey: s.id,
      params: {
        route: spine.kind === 'lane' ? 'corridor lane' : 'bar trunk',
        pipeLaneOffset: DEFAULT_LANES.pipe,
        pipeZ: round(baseZ, 3),
        ductZ: round(bands.ductZ, 3),
        ceilingZ: round(bands.ceilingZ, 3),
        trunks: spine.paths.length,
        wallInset: spine.kind === 'trunk' ? TRUNK_WALL_INSET : 0,
        stacksFed: on.length,
        dcwMainDiameter: dcwD,
      },
      note: spine.kind === 'trunk'
        ? 'no corridor on this floor: one trunk per bar along its long axis, one L-shaped tap per riser'
        : undefined,
    });
    if (s.id === ground) groundSpine = spineAt(spine, baseZ);
  }

  // ground-floor main from the meter to the corridor lane / bar trunk
  if (groundSpine) {
    const startZ = groundSpine.z;
    emitRun(st, {
      storey: ground, system: 'dcw', diameter: serviceDiameter,
      path: [
        [meter[0], meter[1], 0.6],
        [meter[0], meter[1], startZ],
        ...spineTap(groundSpine, meter, startZ).slice().reverse(),
      ],
      roomId: room.id,
      name: `Cold water main from meter Ø${Math.round(serviceDiameter * 1000)}`,
      patterns: ['PLB-07', 'PLB-11'],
    });
  } else {
    // single-stack building (a house): straight from the meter to the stack
    const si = st.stacks[0];
    if (si) {
      const target = stackXY(si, 'dcw');
      emitRun(st, {
        storey: ground, system: 'dcw', diameter: serviceDiameter,
        path: [
          [meter[0], meter[1], 0.6],
          [meter[0], meter[1], 0.45],
          [target[0], meter[1], 0.45],
          [target[0], target[1], 0.45],
        ],
        roomId: room.id, stackId: si.stack.id,
        name: `Cold water main from meter Ø${Math.round(serviceDiameter * 1000)}`,
        patterns: ['PLB-07'],
      });
    }
  }

  buildBuildingDrain(st, room);
  if (st.buildingStoreys.some(s => s.index < 0)) {
    warn(st, 'basement',
      `the building drain and the sewer lateral are modelled at ${ground} (z ${BUILDING_DRAIN_Z} / ${SEWER_Z}); fixtures in a basement below the sewer invert would need a sump and ejector pump, which is not modelled`);
  }
  return { serviceDiameter, peakFlowLps, meterRoomId: room.id, booster };
}

/** Building drain below the ground slab: stack bases → collector → sewer lateral to the street */
function buildBuildingDrain(st: PlumbState, room: RoomDef): void {
  const ground = st.groundStorey;
  const on = stacksOn(st, ground);
  const drains = st.fixtures.filter(f => f.type === 'floor-drain' && f.storey === ground);
  if (on.length === 0 && drains.length === 0) return;

  const anchors: Vec2[] = [
    ...on.map(si => stackXY(si, 'waste')),
    ...drains.map(f => [f.position[0], f.position[1]] as Vec2),
  ];
  const route = spineFor(st, ground, anchors, DEFAULT_LANES.pipe);
  const collector = route && (on.length >= 2 || drains.length >= 2)
    ? spineAt(route, BUILDING_DRAIN_Z)
    : null;

  const totalDfu = st.fixtures.reduce((s, f) => s + f.dfu, 0);
  const drainD = totalDfu > 1400 ? 0.2 : totalDfu > 500 ? 0.15 : 0.1;

  if (collector) {
    for (const path of spinePaths(collector)) {
      emitRun(st, {
        storey: ground, system: 'waste', diameter: drainD, path,
        name: `Building drain Ø${Math.round(drainD * 1000)}`,
        patterns: ['PLB-07'],
        psetExtra: [{ name: 'DFU', value: round(totalDfu, 1) }, { name: 'Slope', value: 0.02 }],
      });
    }
    const ordered = [...on].sort((a, b) =>
      spineStation(collector, stackXY(a, 'waste')) - spineStation(collector, stackXY(b, 'waste'))
      || a.stack.id.localeCompare(b.stack.id));
    for (const si of ordered) {
      const base = stackXY(si, 'waste');
      emitRun(st, {
        storey: ground, system: 'waste', diameter: 0.1,
        path: [
          [base[0], base[1], WASTE_Z],
          [base[0], base[1], BUILDING_DRAIN_Z],
          ...spineTap(collector, base, BUILDING_DRAIN_Z).slice().reverse(),
        ],
        stackId: si.stack.id, name: 'Stack base to building drain Ø100',
        patterns: ['PLB-07', 'PLB-01'],
      });
    }
    for (const fd of drains) {
      const at: Vec2 = [fd.position[0], fd.position[1]];
      const tap = spineTap(collector, at, BUILDING_DRAIN_Z);
      if (tap.length === 0) continue;
      if (dist(at, [tap[0][0], tap[0][1]]) > 30) continue;
      emitRun(st, {
        storey: ground, system: 'waste', diameter: 0.075,
        path: [
          [at[0], at[1], -0.25],
          [at[0], at[1], BUILDING_DRAIN_Z],
          ...tap.slice().reverse(),
        ],
        servesFixtureIds: [fd.id], roomId: fd.roomId,
        name: 'Floor drain to building drain Ø75', patterns: ['PLB-07'],
      });
    }
    // sewer lateral: along the collector to the exit station, then straight out to the street
    const streetTarget: Vec2 = [meterOrNearestX(st, room, anchors), st.siteBounds.y];
    emitRun(st, {
      storey: ground, system: 'waste', diameter: Math.max(0.15, drainD),
      path: streetLateral(collector, streetTarget, BUILDING_DRAIN_Z, SEWER_Z, st.siteBounds.y),
      name: `Sewer lateral Ø${Math.round(Math.max(0.15, drainD) * 1000)}`,
      patterns: ['PLB-07'],
      psetExtra: [{ name: 'DFU', value: round(totalDfu, 1) }, { name: 'InvertZ', value: SEWER_Z }],
    });
    bump(st, 'buildingDrain');
  } else if (on.length === 1) {
    const base = stackXY(on[0], 'waste');
    emitRun(st, {
      storey: ground, system: 'waste', diameter: Math.max(0.1, drainD),
      path: [
        [base[0], base[1], WASTE_Z],
        [base[0], base[1], SEWER_Z],
        [base[0], Math.min(base[1], room.rect.y), SEWER_Z],
        [base[0], st.siteBounds.y, SEWER_Z],
      ],
      stackId: on[0].stack.id, name: 'Building drain / sewer lateral Ø100',
      patterns: ['PLB-07'],
    });
    bump(st, 'buildingDrain');
  }
}

/**
 * Plan X the buried lateral aims for: the drainage anchor nearest the street, so the lateral
 * leaves the building at the frontage and perpendicular to it (never a diagonal across the plot).
 */
function meterOrNearestX(st: PlumbState, room: RoomDef, anchors: Vec2[]): number {
  if (anchors.length === 0) return round(rectCenter(room.rect)[0], 3);
  let best = anchors[0];
  for (const a of anchors) {
    if (a[1] < best[1] - 1e-6 || (Math.abs(a[1] - best[1]) < 1e-6 && a[0] < best[0])) best = a;
  }
  return round(best[0], 3);
}
