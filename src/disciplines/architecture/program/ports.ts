/**
 * Unit ports — the outputs plumbing, mechanical, electrical and the editor consume instead of
 * rediscovering a dwelling's geometry (mechanism 3: ports, not rediscovery).
 *
 * Extracted from `unit-layout.ts` so both engines publish the same ports from the same code, and so
 * the numbers below (trap arm, extract rates, panel height) sit next to the reasoning for them.
 * `atFrac` is the station's local u over the frontage, so two identical modules on different storeys
 * publish the SAME fraction — that, not a coordinate handed down by the placer, is what makes stacks,
 * chases and shafts line up vertically.
 */
import type {
  ExhaustPort, PanelPort, StackPort,
} from './types.ts';
import type {
  FurnitureDef, FurnitureType, Rect, RoomType, Side, Vec2, WallDef,
} from '../../../core/types.ts';
import type { UnitLayoutRequest } from '../unit-layout-types.ts';
import type { Frame, RoomRec } from '../unit-layout.ts';
import { projectOnSegment, round, segPointAt } from '../../../core/geometry.ts';
import { FURNITURE_CATALOG } from '../furniture.ts';

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/**
 * Longest developed trap arm a 50 mm branch may have before it needs its own vent
 * (IPC 2021 Table 1002.2, 2 in = 1.83 m). `plumbing/tables.ts` `maxTrapArm(0.05)` is the same number;
 * architecture may not import a discipline, so it is restated here and `ports.test.ts` asserts they agree.
 */
export const TRAP_ARM_MAX = 1.83;

/** ASHRAE 62.2 / EXTRACT_LS in mechanical/loads.ts — restated for the same reason */
export const EXHAUST_LS: Partial<Record<RoomType, number>> = {
  kitchen: 50, 'living-kitchen': 50, 'shared-kitchen': 50,
  bathroom: 25, ensuite: 25, wc: 13, powder: 13, laundry: 15, utility: 15,
};

/** Centre of a dwelling panelboard: electrical's PANEL_SPEC['unit-panel'] bottom 1.2 + h/2 */
export const PANEL_CENTRE_Z = 1.575;

interface WetHit {
  /** the fixture's room */
  room: RoomRec;
  type: FurnitureType;
  wallId: string;
  /** distance along the wet wall from its stored start */
  along: number;
  /** perpendicular distance from the wall centreline to the fixture */
  offset: number;
  /** world centre of the fixture, so a group can be re-projected onto another wall when merged */
  at: Vec2;
}

/**
 * World centre of a placed item. `FurnitureDef.position` is the footprint's min corner BEFORE the rotation about
 * that corner, so the centre is the half-diagonal rotated by the same angle — using `position` directly would put a
 * WC up to its own depth away from where it stands and inflate its trap arm.
 */
export function furnitureCentre(f: FurnitureDef): Vec2 {
  const co = Math.cos(f.rotation);
  const si = Math.sin(f.rotation);
  return [
    f.position[0] + co * (f.width / 2) - si * (f.depth / 2),
    f.position[1] + si * (f.width / 2) + co * (f.depth / 2),
  ];
}

export function toLocalPoint(frame: Frame, p: Vec2): Vec2 {
  const o = frame.toWorld(0, 0);
  const du = frame.dir('u+');
  const dv = frame.dir('v+');
  return [(p[0] - o[0]) * du[0] + (p[1] - o[1]) * du[1], (p[0] - o[0]) * dv[0] + (p[1] - o[1]) * dv[1]];
}

/**
 * Derive the unit's ports from the laid-out fixtures.
 *
 *  - **stack ports**: every wet fixture is projected onto the nearest wet wall and grouped along it. A group's
 *    station is the point that MINIMISES the longest developed trap arm in the group — for arms
 *    `|u_i − s| + c_i` that is `s* = (max(u_i + c_i) + min(u_i − c_i)) / 2` with the value
 *    `(max(u_i + c_i) − min(u_i − c_i)) / 2`. Groups grow along the wall while that value stays inside
 *    `TRAP_ARM_MAX`, so no branch needs a second vent and plumbing never has to split or repair a stack.
 *  - **exhaust ports**: one per kitchen / bath / laundry, on the corridor-side boundary wall at the room's centre.
 *  - **panel port**: the hall or entry, on the wall of that room facing the access side.
 *
 * `atFrac` is the station's local u divided by the frontage, so two identical units on different storeys produce
 * the same fraction — that, not a coordinate handed down from the placer, is what makes stacks line up.
 */
export function unitPorts(args: {
  req: UnitLayoutRequest; frame: Frame; rooms: RoomRec[]; furniture: FurnitureDef[];
  walls: WallDef[]; wetWallIds: string[];
  /** how many stacks the program allows (XD-01); groups are merged toward it while the arms allow */
  maxStacks?: number;
}): { stackPorts: StackPort[]; exhaustPorts: ExhaustPort[]; panelPort: PanelPort | null } {
  const { req, frame, rooms, furniture } = args;
  const F = Math.max(frame.F, 1e-6);
  const roomById = new Map(rooms.map(r => [r.id, r] as const));
  const wetWalls = args.wetWallIds
    .map(id => args.walls.find(w => w.id === id))
    .filter((w): w is WallDef => !!w);

  // --- stack ports ---------------------------------------------------------
  const boundary = (['front', 'rear', 'left', 'right'] as Side[])
    .map(sd => req.boundaryWalls[sd])
    .filter((w): w is WallDef => !!w);
  const byWallId = new Map([...args.walls, ...boundary].map(w => [w.id, w] as const));
  /** walls a stack could sit in for a fixture in `room`, memoised per room (a bath asks three times) */
  const roomWallCache = new Map<string, [WallDef[], WallDef[]]>();
  const roomWalls = (room: RoomRec, external: boolean): WallDef[] => {
    let hit = roomWallCache.get(room.id);
    if (!hit) {
      const all = room.def.wallIds.map(id => byWallId.get(id)).filter((w): w is WallDef => !!w);
      hit = [[...wetWalls, ...all.filter(w => w.isExternal !== true)], [...wetWalls, ...all]];
      roomWallCache.set(room.id, hit);
    }
    return external ? hit[1] : hit[0];
  };
  const nearest = (room: RoomRec, type: FurnitureType, c: Vec2, cands: readonly WallDef[]): WetHit | null => {
    let best: WetHit | null = null;
    for (const w of cands) {
      const pr = projectOnSegment({ a: w.start, b: w.end }, c);
      const offset = Math.abs(pr.offset);
      if (!best || offset < best.offset - 1e-9 || (Math.abs(offset - best.offset) <= 1e-9 && w.id < best.wallId)) {
        best = { room, type, wallId: w.id, along: pr.clamped, offset, at: c };
      }
    }
    return best;
  };
  const hits: WetHit[] = [];
  for (const f of furniture) {
    if (FURNITURE_CATALOG[f.type].needsWater !== true) continue;
    const room = roomById.get(f.roomId);
    if (!room) continue;
    const c = furnitureCentre(f);
    // The wet wall serves everything within a trap arm of it (XD-01: one stack per unit). A fixture farther than
    // that gets a second station in the nearest wall of its own room — what a plumber would do rather than run an
    // unvented 3 m branch (IPC 2021 §1002.2 / Table 1002.2) — preferring an internal wall, and settling for the
    // exterior wall only when the fixtures run along it (a laneway house's bathroom does).
    let best = nearest(room, f.type, c, wetWalls);
    // only look past the wet wall when it is out of reach — which is the exception, not the rule
    if (!best || best.offset > TRAP_ARM_MAX) {
      best = nearest(room, f.type, c, roomWalls(room, false)) ?? best;
      if (!best || best.offset > TRAP_ARM_MAX) best = nearest(room, f.type, c, roomWalls(room, true)) ?? best;
    }
    if (best) hits.push(best);
  }

  const byWall = new Map<string, WetHit[]>();
  for (const h of hits) {
    const list = byWall.get(h.wallId) ?? [];
    list.push(h);
    byWall.set(h.wallId, list);
  }
  const groups: { wallId: string; hits: WetHit[] }[] = [];
  for (const wallId of [...byWall.keys()].sort()) {
    const list = (byWall.get(wallId) ?? []).slice().sort((a, b) => a.along - b.along || (a.type < b.type ? -1 : 1));
    let group: WetHit[] = [];
    let hiRun = -Infinity;
    let loRun = Infinity;
    for (const h of list) {
      const hi = Math.max(hiRun, h.along + h.offset);
      const lo = Math.min(loRun, h.along - h.offset);
      if (group.length > 0 && (hi - lo) / 2 > TRAP_ARM_MAX + 1e-6) {
        groups.push({ wallId, hits: group });
        group = [];
        hiRun = h.along + h.offset;
        loRun = h.along - h.offset;
      } else {
        hiRun = hi;
        loRun = lo;
      }
      group.push(h);
    }
    if (group.length > 0) groups.push({ wallId, hits: group });
  }

  // XD-01 wants one stack per dwelling (two when the program declares an en-suite group). Merge groups
  // while the merged station still keeps every branch inside its own trap arm — re-projecting the moved
  // fixtures onto the surviving wall, because that is where the stack would actually stand.
  const want = Math.max(1, args.maxStacks ?? 2);
  const reproject = (hs: readonly WetHit[], wallId: string): WetHit[] => {
    const w = byWallId.get(wallId);
    if (!w) return [...hs];
    return hs.map(h => {
      const pr = projectOnSegment({ a: w.start, b: w.end }, h.at);
      return { ...h, wallId, along: pr.clamped, offset: Math.abs(pr.offset) };
    });
  };
  for (let guard = 0; groups.length > want && guard < 8; guard++) {
    let best: { i: number; j: number; hits: WetHit[]; wallId: string; arm: number } | null = null;
    for (let i = 0; i < groups.length; i++) {
      for (let j = 0; j < groups.length; j++) {
        if (i === j) continue;
        const hitsIn = [...groups[i].hits, ...reproject(groups[j].hits, groups[i].wallId)];
        const arm = station(hitsIn).arm;
        if (best === null || arm < best.arm) best = { i, j, hits: hitsIn, wallId: groups[i].wallId, arm };
      }
    }
    if (!best || best.arm > TRAP_ARM_MAX + 1e-6) break;
    const keep = groups.filter((_, k) => k !== best.i && k !== best.j);
    keep.splice(Math.min(best.i, best.j), 0, { wallId: best.wallId, hits: best.hits });
    groups.length = 0;
    groups.push(...keep);
  }

  const stackPorts: StackPort[] = groups.map((g, i) => {
    const wall = byWallId.get(g.wallId)!;
    const st = station(g.hits);
    const at = segPointAt({ a: wall.start, b: wall.end }, st.u);
    const local = toLocalPoint(frame, at);
    const serves = [...new Set(g.hits.map(h => h.room.def.ref ?? h.room.cell.type))].sort();
    const hot = g.hits.some(h => h.type !== 'wc');
    return {
      id: `stack.${i + 1}`,
      xy: [round(at[0], 4), round(at[1], 4)],
      atFrac: round(clamp(local[0] / F, 0, 1), 6),
      wallId: g.wallId,
      serves,
      systems: hot ? ['waste', 'vent', 'dcw', 'dhw'] : ['waste', 'vent', 'dcw'],
      maxArm: round(st.arm, 3),
    };
  });

  // --- exhaust ports -------------------------------------------------------
  const accessWall = req.boundaryWalls[req.accessSide];
  const exhaustPorts: ExhaustPort[] = [];
  if (accessWall) {
    const seg = { a: accessWall.start, b: accessWall.end };
    const len = Math.hypot(seg.b[0] - seg.a[0], seg.b[1] - seg.a[1]) || 1;
    for (const r of rooms) {
      if (r.outside) continue;
      const flow = EXHAUST_LS[r.cell.type];
      if (flow === undefined) continue;
      const centre = frame.toWorld(r.local.x + r.local.w / 2, r.local.y + r.local.h / 2);
      const at = clamp(projectOnSegment(seg, centre).along, 0.15, len - 0.15);
      const xy = segPointAt(seg, at);
      exhaustPorts.push({
        id: `exhaust.${exhaustPorts.length + 1}`,
        xy: [round(xy[0], 4), round(xy[1], 4)],
        atFrac: round(clamp(toLocalPoint(frame, xy)[0] / F, 0, 1), 6),
        side: req.accessSide,
        kind: r.cell.type === 'laundry' || r.cell.type === 'utility' ? 'dryer'
          : r.cell.type === 'kitchen' || r.cell.type === 'living-kitchen' || r.cell.type === 'shared-kitchen' ? 'kitchen'
            : 'bath',
        flowLs: flow,
      });
    }
  }

  // --- panel port ----------------------------------------------------------
  let panelPort: PanelPort | null = null;
  const hall = rooms.find(r => !r.outside && r.cell.type === 'entry')
    ?? rooms.find(r => !r.outside && r.cell.type === 'hall')
    ?? rooms.find(r => !r.outside && r.cell.type === 'corridor');
  if (hall) {
    // the wall of the hall that faces the access side, pulled 0.15 m into the room
    const host = accessWall ?? args.walls.find(w => w.leftRoomId === hall.id || w.rightRoomId === hall.id);
    const inward = frame.dir('v+');
    const p = frame.toWorld(hall.local.x + hall.local.w / 2, hall.local.y);
    panelPort = {
      id: 'panel.1',
      xy: [round(p[0] + inward[0] * 0.15, 4), round(p[1] + inward[1] * 0.15, 4)],
      wallId: host?.id ?? '',
      roomId: hall.id,
      height: PANEL_CENTRE_Z,
    };
  }

  return { stackPorts, exhaustPorts, panelPort };
}

/**
 * The station on the wall that minimises the longest developed trap arm of `group`, and that length.
 * Arm of fixture i = |u_i − s| + c_i, so the minimax point balances the two extreme constraints.
 */
export function station(group: readonly WetHit[]): { u: number; arm: number } {
  let hi = -Infinity;
  let lo = Infinity;
  for (const g of group) {
    hi = Math.max(hi, g.along + g.offset);
    lo = Math.min(lo, g.along - g.offset);
  }
  return { u: (hi + lo) / 2, arm: Math.max(0, (hi - lo) / 2) };
}

