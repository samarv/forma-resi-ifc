/**
 * Step 6 — fire protection (PLB-05 Sprinklers Where People Sleep, PLB-10 Standpipes in the Stairs).
 *
 * Heads go on a 3.7 m / 15 m² grid in every room, just under the ceiling. Branch lines (Ø25) per
 * room gather to a unit main (Ø32) above the entry door, the unit mains hang off a corridor main
 * (Ø50) in the sprinkler lane of the service spine, and the corridor mains are fed by a Ø100
 * riser in the corner of every exit stair which doubles as the fire standpipe.
 */
import type { ArchModel, CoreDef, Rect, RoomDef, Segment2, Vec2, Vec3, WallDef } from '../../core/types.ts';
import { dist, rectCenter, round, segLength, segPointAt } from '../../core/geometry.ts';
import { DEFAULT_LANES } from '../../core/coordination.ts';
import { addFixture, emitAxis, emitBox, emitRun, warn, bump, info, barsOn, type PlumbState } from './state.ts';
import {
  laneSpine, manhattanLink, spineStation, spineTap, trunkSpine, TRUNK_WALL_INSET, type Spine,
} from './routing.ts';

const MAX_SPACING = 3.7;
const COVERAGE = 15;
const WALL_CLEARANCE = 0.1;
const MIN_GRID_AREA = 3.0;
const MIN_HEAD_AREA = 2.0;

const NO_HEAD_ROOMS = new Set([
  'balcony', 'terrace', 'courtyard', 'roof', 'landscape', 'shaft', 'elevator', 'porch',
]);

export interface SprinklerResult {
  active: boolean;
  heads: number;
  standpipes: number;
  hoseValves: number;
}

/**
 * Sprinklers are required when the typology says so, above three storeys anywhere, or — in the
 * UK/IE — once the top storey is 11 m above ground (Approved Document B Vol 1 §0.16).
 */
export function sprinklersRequired(st: PlumbState): boolean {
  const above = st.buildingStoreys.filter(s => s.index >= 0);
  if (st.ctx.typology.sprinklered || above.length > 3) return true;
  const region = st.ctx.spec.region;
  if (region !== 'UK' && region !== 'IE') return false;
  const topFloorHeight = above.slice(0, -1).reduce((s, x) => s + x.height, 0);
  return topFloorHeight >= 11;
}

/**
 * Head grid inside a rect, grouped into BRANCH LINES: max 3.7 m spacing, ≤ 15 m² per head,
 * ≥ 0.1 m off the walls. Each returned row is a straight line of heads along the room's long
 * axis, so a branch line through it is axis-parallel by construction (no zig-zag between heads).
 */
export function headRows(rect: Rect, area: number): Vec2[][] {
  if (area < MIN_HEAD_AREA) return [];
  if (area < MIN_GRID_AREA) return [[rectCenter(rect)]];
  const w = Math.max(0.2, rect.w - 2 * WALL_CLEARANCE);
  const h = Math.max(0.2, rect.h - 2 * WALL_CLEARANCE);
  let nx = Math.max(1, Math.ceil(w / MAX_SPACING));
  let ny = Math.max(1, Math.ceil(h / MAX_SPACING));
  let guard = 0;
  while (nx * ny * COVERAGE < area && guard++ < 12) {
    if (w / nx >= h / ny) nx++; else ny++;
  }
  const xs = Array.from({ length: nx }, (_, i) => rect.x + WALL_CLEARANCE + w * (i + 0.5) / nx);
  const ys = Array.from({ length: ny }, (_, j) => rect.y + WALL_CLEARANCE + h * (j + 0.5) / ny);
  const rows: Vec2[][] = [];
  if (rect.w >= rect.h) {
    for (const y of ys) rows.push(xs.map(x => [x, y] as Vec2));
  } else {
    for (const x of xs) rows.push(ys.map(y => [x, y] as Vec2));
  }
  return rows;
}

/** Flat head layout of a room (rows concatenated) */
export function headGrid(rect: Rect, area: number): Vec2[] {
  const out: Vec2[] = [];
  for (const row of headRows(rect, area)) out.push(...row);
  return out;
}

function doorPoint(arch: ArchModel, doorId: string | undefined, wallById: Map<string, WallDef>): Vec2 | null {
  if (!doorId) return null;
  const door = arch.doors.find(d => d.id === doorId);
  if (!door) return null;
  const wall = wallById.get(door.wallId);
  if (!wall) return null;
  return segPointAt({ a: wall.start, b: wall.end }, door.along);
}

/**
 * Emit the pipework of one room: the room main along the branch-line starts, then one straight
 * branch line per row of heads. `feed` is the point (on the corridor main, the bar trunk or the
 * unit main) the room hangs off.
 */
function emitRoomPipework(
  st: PlumbState,
  o: {
    storey: string; rows: Vec2[][]; headIds: string[][]; feed: Vec3; branchZ: number;
    mainDiameter: number; branchDiameter: number; roomId?: string; unitId?: string; name: string;
  },
): void {
  const starts = o.rows.map(r => [r[0][0], r[0][1], o.branchZ] as Vec3);
  if (starts.length === 0) return;
  emitRun(st, {
    storey: o.storey, system: 'sprinkler', diameter: o.mainDiameter,
    path: [...manhattanLink(o.feed, starts[0]), ...starts.slice(1)],
    roomId: o.roomId, unitId: o.unitId,
    name: `${o.name} Ø${Math.round(o.mainDiameter * 1000)}`,
    patterns: ['PLB-05'],
    psetExtra: [{ name: 'BranchLines', value: o.rows.length }],
  });
  for (let j = 0; j < o.rows.length; j++) {
    const row = o.rows[j];
    if (row.length < 2) continue;
    emitRun(st, {
      storey: o.storey, system: 'sprinkler', diameter: o.branchDiameter,
      path: row.map(p => [p[0], p[1], o.branchZ] as Vec3),
      servesFixtureIds: o.headIds[j], roomId: o.roomId, unitId: o.unitId,
      name: `Sprinkler branch line Ø${Math.round(o.branchDiameter * 1000)}`,
      patterns: ['PLB-05'],
      psetExtra: [{ name: 'Heads', value: row.length }],
    });
  }
}

export function buildFireProtection(st: PlumbState): SprinklerResult {
  const active = sprinklersRequired(st);
  const arch = st.ctx.arch as ArchModel;
  const result: SprinklerResult = { active, heads: 0, standpipes: 0, hoseValves: 0 };
  const aboveGrade = st.buildingStoreys.filter(s => s.index >= 0).length;

  if (!active) {
    warn(st, 'nosprinkler', `typology is not sprinklered and the building is ${aboveGrade} storeys — no sprinkler system generated`);
  }

  const wallById = new Map(arch.walls.map(w => [w.id, w] as const));
  const roomById = new Map(arch.rooms.map(r => [r.id, r] as const));
  const low = st.detail === 'low';

  // --- standpipe / sprinkler risers in the stair cores (PLB-10) ------------
  // IBC §905.3.1: standpipes once the highest floor is more than ~9 m above fire-service access.
  const needStandpipe = aboveGrade >= 4;
  const riserByCore = new Map<string, Vec2>();
  const cores: CoreDef[] = needStandpipe ? arch.cores : [];
  for (const core of cores) {
    const xy: Vec2 = [core.rect.x + 0.3, core.rect.y + 0.3];
    riserByCore.set(core.id, xy);
    const storeys = st.buildingStoreys.filter(s => core.storeys.includes(s.id));
    const list = storeys.length > 0 ? storeys : st.buildingStoreys.filter(s => s.index >= 0);
    const ids: string[] = [];
    for (const s of list) {
      const f2f = info(st, s.id).f2f;
      const seg = emitAxis(st, {
        storey: s.id, system: 'standpipe', diameter: 0.1,
        a: [xy[0], xy[1], 0], b: [xy[0], xy[1], f2f],
        name: 'Fire standpipe riser Ø100',
        patterns: ['PLB-10'],
        psetExtra: [{ name: 'Class', value: 'I (2½ in hose connections)' }, { name: 'CoreId', value: core.id }],
      });
      if (seg) ids.push(seg.id);
      // isolating valve at every floor
      emitBox(st, {
        storey: s.id, ifcType: 'IfcValve', predefinedType: 'ISOLATING',
        name: 'Standpipe floor control valve', objectType: 'Riser control valve',
        center: [xy[0] + 0.35, xy[1], 1.5], width: 0.2, depth: 0.2, height: 0.25,
        system: 'standpipe', roomId: core.roomIds[0], patterns: ['PLB-10'], kind: 'VLV',
        psets: [{
          name: 'Forma_Plumbing',
          properties: [
            { name: 'System', value: 'Fire standpipe' },
            { name: 'CoreId', value: core.id },
            { name: 'Supervised', value: true },
          ],
        }],
      });
      bump(st, 'riserValves');
      if (aboveGrade > 4) {
        addFixture(st, {
          type: 'fire-hose-valve', storey: s.id, center: [xy[0], xy[1] + 0.35, 1.2],
          roomId: core.roomIds[0], solid: true, patterns: ['PLB-10'],
          extraProps: [{ name: 'Class', value: 'I' }, { name: 'CoreId', value: core.id }],
        });
        result.hoseValves++;
        bump(st, 'hoseValves');
      }
    }
    result.standpipes++;
    st.apps.push({
      patternId: 'PLB-10',
      elementIds: ids,
      params: {
        coreId: core.id, standpipeDiameter: 0.1, storeys: list.length,
        hoseValves: aboveGrade > 4 ? list.length : 0, hoseValveHeight: 1.2,
      },
      note: aboveGrade > 4 ? 'Class I hose valves at every floor (IBC §905.3.1)' : 'riser with floor control valves only',
    });
    bump(st, 'standpipes');
  }

  // fire department connection at the street face
  const fdcAt = needStandpipe || active ? fdcPosition(st, arch) : null;
  if (fdcAt) {
    addFixture(st, {
      type: 'fire-hose-valve', storey: st.groundStorey, center: [fdcAt[0], fdcAt[1], 0.9],
      solid: true, patterns: ['PLB-10'],
      ifcType: 'IfcFireSuppressionTerminal', predefinedType: 'FIREHYDRANT',
      objectType: 'FDC', name: 'Fire department connection (FDC)',
      extraProps: [
        { name: 'Type', value: 'Siamese FDC 2 × 65 mm' },
        { name: 'MountingHeight', value: 0.9 },
        { name: 'IfcNote', value: 'BREECHINGINLET is the stricter IFC4 match; FIREHYDRANT kept for viewer compatibility' },
      ],
    });
    bump(st, 'fdc');
  }

  if (!active) return result;

  // --- heads, branch lines, unit mains, corridor mains ---------------------
  for (const s of st.buildingStoreys) {
    const si = info(st, s.id);
    const plan = si.plan;
    if (!plan) continue;
    const headZ = Math.max(1.8, si.ceiling - 0.05);
    const branchZ = Math.max(1.7, si.ceiling - 0.12);

    // --- 1. head layout, so the mains can be routed to serve it ------------
    interface Served {
      room: RoomDef | null;
      unit: string | undefined;
      rows: Vec2[][];
      /** Point the room hangs off the floor's main: the unit main, or the room main start */
      anchor: Vec2;
    }
    const served: Served[] = [];
    const unitAnchors = new Map<string, { inward: Vec2; entry: Vec2; doorId: string }>();

    for (const unitId of plan.unitIds) {
      const unit = arch.units.find(u => u.id === unitId);
      if (!unit) continue;
      const entry = doorPoint(arch, unit.entryDoorId, wallById) ?? rectCenter(unit.rect);
      const unitCenter = rectCenter(unit.rect);
      const inward: Vec2 = [
        entry[0] + Math.sign(unitCenter[0] - entry[0]) * 0.35,
        entry[1] + Math.sign(unitCenter[1] - entry[1]) * 0.35,
      ];
      unitAnchors.set(unit.id, { inward, entry, doorId: unit.entryDoorId });
      const rooms = unit.roomIds.map(id => roomById.get(id))
        .filter((r): r is RoomDef => !!r && r.storey === s.id && !NO_HEAD_ROOMS.has(r.type));
      if (low) {
        const biggest = [...rooms].sort((a, b) => b.area - a.area)[0];
        const p = biggest ? rectCenter(biggest.rect) : unitCenter;
        served.push({ room: biggest ?? null, unit: unit.id, rows: [[p]], anchor: inward });
        continue;
      }
      for (const room of rooms) {
        const rows = headRows(room.rect, room.area);
        if (rows.length === 0) continue;
        served.push({ room, unit: unit.id, rows, anchor: inward });
      }
    }
    if (!low) {
      for (const roomId of plan.commonRoomIds ?? []) {
        const room = roomById.get(roomId);
        if (!room || room.storey !== s.id) continue;
        if (room.type === 'corridor' || NO_HEAD_ROOMS.has(room.type)) continue;
        const rows = headRows(room.rect, room.area);
        if (rows.length === 0) continue;
        served.push({ room, unit: undefined, rows, anchor: rows[0][0] });
      }
    }

    // --- 2. the floor's sprinkler route ------------------------------------
    const corridors: Segment2[][] = (plan.corridors ?? []).map(c => c.centerline).filter(c => c.length > 0);
    const segs = corridors.flat();
    let spine: Spine | null = laneSpine(corridors, DEFAULT_LANES.sprinkler, si.bands.sprinklerZ);
    if (!spine) {
      const anchors: Vec2[] = [...served.map(x => x.anchor), ...riserByCore.values()];
      spine = trunkSpine(barsOn(st, s.id), anchors, si.trunkZ, TRUNK_WALL_INSET);
    }
    const mainZ = spine ? spine.z : si.bands.sprinklerZ;

    if (spine) {
      const laneNote = spine.kind === 'lane'
        ? `sprinkler lane ${DEFAULT_LANES.sprinkler} m off corridor centreline`
        : `bar trunk ${TRUNK_WALL_INSET} m inside the exterior wall (no corridor on this floor)`;
      for (const path of spine.paths) {
        emitRun(st, {
          storey: s.id, system: 'sprinkler', diameter: 0.05, path,
          name: spine.kind === 'lane' ? 'Sprinkler corridor main Ø50' : 'Sprinkler floor trunk Ø50',
          patterns: ['PLB-05', 'PLB-11', 'XD-02'],
          psetExtra: [{ name: 'Lane', value: laneNote }],
        });
      }
      // feed from the nearest core riser
      let bestRiser: Vec2 | null = null;
      let bd = Infinity;
      for (const xy of riserByCore.values()) {
        const tap = spineTap(spine, xy, mainZ);
        const d = tap.length > 0 ? dist(xy, [tap[0][0], tap[0][1]]) : Infinity;
        if (d < bd) { bd = d; bestRiser = xy; }
      }
      if (bestRiser) {
        emitRun(st, {
          storey: s.id, system: 'sprinkler', diameter: 0.05,
          path: spineTap(spine, bestRiser, mainZ).slice().reverse(),
          name: 'Sprinkler feed from riser Ø50', patterns: ['PLB-05', 'PLB-10'],
        });
      }
      bump(st, spine.kind === 'lane' ? 'corridorSprinklerMains' : 'floorSprinklerTrunks');
    }

    // --- 3. corridor heads every ≤ 3.7 m -----------------------------------
    for (const seg of segs) {
      const L = segLength(seg);
      const n = Math.max(1, Math.ceil(L / MAX_SPACING));
      const corridorRoom = (plan.corridors ?? []).find(c => c.centerline.includes(seg))?.roomId;
      for (let i = 0; i < n; i++) {
        const p = segPointAt(seg, L * (i + 0.5) / n);
        addFixture(st, {
          type: 'sprinkler-head', storey: s.id, center: [p[0], p[1], headZ],
          roomId: corridorRoom, solid: true, patterns: ['PLB-05'],
          extraProps: [{ name: 'Coverage', value: COVERAGE }, { name: 'Zone', value: 'corridor' }],
        });
        result.heads++;
      }
    }

    // --- 4. unit mains off the route, ordered along it ---------------------
    const unitMainPt = new Map<string, Vec3>();
    if (spine) {
      const ordered = [...unitAnchors.entries()]
        .sort((a, b) => spineStation(spine!, a[1].entry) - spineStation(spine!, b[1].entry)
          || a[0].localeCompare(b[0]));
      for (const [unitId, a] of ordered) {
        if (!served.some(x => x.unit === unitId)) continue;
        emitRun(st, {
          storey: s.id, system: 'sprinkler', diameter: 0.032,
          path: spineTap(spine, a.inward, mainZ, branchZ),
          unitId, name: 'Sprinkler unit main Ø32',
          patterns: ['PLB-05', 'XD-02'],
          psetExtra: [{ name: 'EntryDoorId', value: a.doorId }],
        });
        unitMainPt.set(unitId, [round(a.inward[0]), round(a.inward[1]), round(branchZ)]);
        bump(st, 'unitSprinklerMains');
      }
    }

    // --- 5. heads + room pipework ------------------------------------------
    for (const x of served) {
      const ids: string[][] = [];
      const headCount = x.rows.reduce((n, r) => n + r.length, 0);
      for (const row of x.rows) {
        const rowIds: string[] = [];
        for (const p of row) {
          const f = addFixture(st, {
            type: 'sprinkler-head', storey: s.id, center: [p[0], p[1], headZ],
            roomId: x.room?.id, unitId: x.unit, solid: true, patterns: ['PLB-05'],
            extraProps: low && x.unit
              ? [{ name: 'Coverage', value: COVERAGE }, { name: 'Detail', value: 'low (one head per dwelling)' }]
              : [
                { name: 'Coverage', value: round((x.room?.area ?? COVERAGE) / Math.max(1, headCount), 2) },
                { name: 'MaxSpacing', value: MAX_SPACING },
                { name: 'RoomType', value: x.room?.type ?? 'common' },
              ],
          });
          rowIds.push(f.id);
          result.heads++;
        }
        ids.push(rowIds);
      }
      // rooms of a dwelling hang off its unit main; common rooms tap the floor's route directly
      const fromUnit = x.unit ? unitMainPt.get(x.unit) : undefined;
      const fromSpine = fromUnit || !spine ? [] : spineTap(spine, x.anchor, mainZ, branchZ);
      const feed: Vec3 = fromUnit
        ?? (fromSpine.length > 0 ? fromSpine[0] : [x.rows[0][0][0], x.rows[0][0][1], branchZ]);
      emitRoomPipework(st, {
        storey: s.id, rows: x.rows, headIds: ids, feed, branchZ,
        mainDiameter: 0.032, branchDiameter: 0.025,
        roomId: x.room?.id, unitId: x.unit,
        name: 'Sprinkler room main',
      });
    }

    st.apps.push({
      patternId: 'PLB-05',
      storey: s.id,
      params: {
        coveragePerHead: COVERAGE,
        maxSpacing: MAX_SPACING,
        headZ: round(headZ, 3),
        route: spine ? (spine.kind === 'lane' ? 'corridor lane' : 'bar trunk') : 'none',
        corridorMainDiameter: 0.05,
        unitMainDiameter: 0.032,
        branchDiameter: 0.025,
        standard: st.ctx.spec.region === 'UK' || st.ctx.spec.region === 'IE' ? 'BS 9251 / Approved Doc B' : 'NFPA 13R',
        detail: st.detail,
      },
      note: 'branch lines run straight along one row of heads; rows gather to a room main',
    });
  }
  return result;
}

/** Front (street-facing) position for the fire department connection */
function fdcPosition(st: PlumbState, arch: ArchModel): Vec2 | null {
  const main = st.ctx.site.entrances.find(e => e.type === 'main');
  if (main) return [main.position[0] + 2.0, Math.max(st.siteBounds.y, main.position[1] - 0.4)];
  const ground = st.groundStorey;
  const front = arch.walls
    .filter(w => w.storey === ground && w.isExternal)
    .sort((a, b) => (a.start[1] + a.end[1]) / 2 - (b.start[1] + b.end[1]) / 2)[0];
  if (!front) return null;
  const seg = { a: front.start, b: front.end };
  const p = segPointAt(seg, segLength(seg) * 0.25);
  return [p[0], p[1] - front.thickness / 2 - 0.15];
}
