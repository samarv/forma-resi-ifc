/**
 * Wet-wall chases — one per dwelling column (XD-01).
 *
 * A dwelling's module declares exactly one wet-wall stack port, so a dwelling gets exactly one chase, at the port's
 * station on the wet wall, and the chase IS the stack station. That is what lets v1's `stacks.ts` search machinery
 * (`primaryWall`, `bestStationFor`, `stationsForGroup`, `MAX_STACKS_PER_GROUP`, the "a second stack was added on its
 * own wet wall" warnings) be deleted: there is nothing left to search for.
 *
 * Inside the chase the systems are laid out along the wall in `SHAFT_SYSTEM_ORDER` with **waste in the centre**,
 * because the waste stack is what the trap arms are measured to, and the rest alternate ± around it.
 */
import type { Segment2, Vec2 } from '../types.ts';
import type { Ledger, RuleSet } from '../rules/types.ts';
import { cite } from '../rules/SOURCES.ts';
import type {
  Box3, Chase, ChaseRequest, Conflict, Reservation, ReserveRequest, ReserveResult, ShaftSystem,
} from './types.ts';
import { SHAFT_SYSTEM_ORDER, isConflict } from './types.ts';
import { SYSTEM_OD, kindOfSystem } from './shafts.ts';

/** Finish thickness taken off each face of the wet wall; the chase is what is left. */
export const CHASE_FINISH = 0.02;
export const CHASE_GAP = 0.02;
export const CHASE_MIN_LENGTH = 0.3;
export const CHASE_SOURCE = cite('IPC 2021', '§704 (one stack, one invert)');

export interface ChaseAllocatorOptions {
  rules: RuleSet;
  ledger: Ledger;
  reserve(req: ReserveRequest): ReserveResult;
  storeyHeight(storey: string): number;
}

export interface ChaseAllocator {
  chase(req: ChaseRequest): Chase | Conflict;
  chaseOf(unitId: string): Chase | null;
  all(): readonly Chase[];
}

function segLen(s: Segment2): number {
  return Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
}
function segDirOf(s: Segment2): Vec2 {
  const l = segLen(s) || 1;
  return [(s.b[0] - s.a[0]) / l, (s.b[1] - s.a[1]) / l];
}
function pointAt(s: Segment2, along: number): Vec2 {
  const d = segDirOf(s);
  return [s.a[0] + d[0] * along, s.a[1] + d[1] * along];
}

function orderedSystems(systems: readonly ShaftSystem[]): ShaftSystem[] {
  const seen = new Set<ShaftSystem>();
  const out: ShaftSystem[] = [];
  for (const s of SHAFT_SYSTEM_ORDER) {
    if (systems.includes(s) && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  for (const s of systems) if (!seen.has(s)) { seen.add(s); out.push(s); }
  return out;
}

/** Stations along the chase, waste at the centre and the rest alternating ± in canonical order. */
export function chaseStations(systems: readonly ShaftSystem[]): { system: ShaftSystem; offset: number; d: number; length: number }[] {
  const ordered = orderedSystems(systems);
  const widths = ordered.map(s => SYSTEM_OD[s] + 2 * 0.013);
  const total = widths.reduce((a, b) => a + b, 0) + Math.max(0, ordered.length - 1) * CHASE_GAP;
  const length = Math.max(CHASE_MIN_LENGTH, total);
  // Place the first (canonically first = waste when present) in the centre, then alternate right, left, right…
  const out: { system: ShaftSystem; offset: number; d: number; length: number }[] = [];
  let right = 0;
  let left = 0;
  for (let i = 0; i < ordered.length; i++) {
    const w = widths[i];
    let offset: number;
    if (i === 0) {
      offset = 0;
      right = w / 2 + CHASE_GAP;
      left = -(w / 2 + CHASE_GAP);
    } else if (i % 2 === 1) {
      offset = right + w / 2;
      right = offset + w / 2 + CHASE_GAP;
    } else {
      offset = left - w / 2;
      left = offset - w / 2 - CHASE_GAP;
    }
    out.push({ system: ordered[i], offset, d: SYSTEM_OD[ordered[i]], length });
  }
  const span = Math.max(right, -left) * 2;
  const finalLength = Math.max(length, span);
  return out.map(o => ({ ...o, length: finalLength }));
}

export function createChaseAllocator(o: ChaseAllocatorOptions): ChaseAllocator {
  const byUnit = new Map<string, Chase>();
  let n = 0;

  return {
    chase(req: ChaseRequest): Chase | Conflict {
      const prev = byUnit.get(req.unitId);
      if (prev) return prev;

      const wallLen = segLen(req.wall);
      if (wallLen <= 1e-6) {
        return { kind: 'conflict', reason: 'no-chase', with: [req.wallId], message: `wet wall ${req.wallId} of ${req.unitId} is degenerate`, ruleId: 'XD-01.wetWall' };
      }
      const stations = chaseStations(req.systems);
      const length = stations.length > 0 ? stations[0].length : CHASE_MIN_LENGTH;
      const thickness = Math.max(0.06, req.wallThickness - 2 * CHASE_FINISH);
      const station = Math.min(Math.max(req.station, length / 2), Math.max(length / 2, wallLen - length / 2));
      const centre = pointAt(req.wall, station);
      const dir = segDirOf(req.wall);

      n += 1;
      const id = `CHS-${String(n).padStart(4, '0')}`;
      const systemXY = new Map<ShaftSystem, Vec2>();
      const systemD = new Map<ShaftSystem, number>();
      for (const s of stations) {
        systemXY.set(s.system, [centre[0] + dir[0] * s.offset, centre[1] + dir[1] * s.offset]);
        systemD.set(s.system, s.d);
      }

      const reservationIds: string[] = [];
      const made: Reservation[] = [];
      for (const storey of req.storeys) {
        const box: Box3 = boxOf(centre, dir, length, thickness, Math.max(0.1, o.storeyHeight(storey)));
        const r = o.reserve({
          owner: 'plumbing', kind: 'waste', storey, container: 'chase', containerId: id, boxes: [box],
          note: `wet-wall chase for ${req.unitId} on ${req.wallId}`,
        });
        if (isConflict(r)) return r;
        made.push(r);
        reservationIds.push(r.id);
      }
      void made;

      const chase: Chase = {
        id, unitId: req.unitId, wallId: req.wallId,
        xy: centre, dir, length, thickness, storeys: req.storeys,
        systemXY, systemD, reservationIds,
      };
      byUnit.set(req.unitId, chase);
      return chase;
    },

    chaseOf(unitId: string): Chase | null {
      return byUnit.get(unitId) ?? null;
    },

    all(): readonly Chase[] {
      return [...byUnit.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    },
  };
}

function boxOf(centre: Vec2, dir: Vec2, length: number, thickness: number, height: number): Box3 {
  // Axis-aligned bounds of the chase footprint (wet walls are orthogonal in this model).
  const halfAlong: Vec2 = [dir[0] * length / 2, dir[1] * length / 2];
  const n: Vec2 = [-dir[1], dir[0]];
  const halfAcross: Vec2 = [n[0] * thickness / 2, n[1] * thickness / 2];
  const xs = [centre[0] - halfAlong[0] - halfAcross[0], centre[0] + halfAlong[0] + halfAcross[0], centre[0] - halfAlong[0] + halfAcross[0], centre[0] + halfAlong[0] - halfAcross[0]];
  const ys = [centre[1] - halfAlong[1] - halfAcross[1], centre[1] + halfAlong[1] + halfAcross[1], centre[1] - halfAlong[1] + halfAcross[1], centre[1] + halfAlong[1] - halfAcross[1]];
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return { x: x0, y: y0, z: 0, w: Math.max(...xs) - x0, d: Math.max(...ys) - y0, h: height };
}

/** The kinds a chase hosts, for the band/keep-out checks. */
export function chaseKinds(systems: readonly ShaftSystem[]): ReturnType<typeof kindOfSystem>[] {
  return orderedSystems(systems).map(kindOfSystem);
}
