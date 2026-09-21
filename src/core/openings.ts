/**
 * F4 — Door geometry algebra: the single owner of the hinge/swing convention.
 *
 * Convention (also documented on DoorDef in types.ts):
 *  - `along`  : distance from the HOST WALL's stored `start` to the door centre.
 *  - `hinge`  : which END of the opening carries the hinge, 'start' = the end nearer wall.start, in the wall's
 *               STORED start→end direction. Convention-independent because it is a property of the WallDef object the
 *               door already resolves through `wallId`.
 *  - `swing`  : side of the host wall the leaf's motion volume occupies, 'left' | 'right' of the stored start→end
 *               direction (left normal = [-dir.y, dir.x]). 'none' for rolling doors and cased openings.
 *  - `motion` : only 'swing' | 'double-swing' draw an arc.
 *
 * Every producer derives hinge + swing here (solveSwing) and every consumer (2D plan, IFC writer, switch placement,
 * furniture keep-out) reads the stored fields through the helpers below. Nothing infers a swing from a wall normal.
 */
import type { DoorDef, DoorHinge, DoorMotion, DoorSwing, Rect, Vec2, WallDef } from './types.ts';

export type WallRef = Pick<WallDef, 'start' | 'end'>;
export interface SwingSolution { hinge: DoorHinge; swing: DoorSwing; }

/** The fields the geometry helpers need; `motion`/`hinge`/`swing` are optional only for legacy doors during migration. */
export type DoorGeom = Pick<DoorDef, 'along' | 'width'> & Partial<Pick<DoorDef, 'hinge' | 'swing' | 'motion'>> & { operation?: string };

export interface SwingArc {
  /** hinge point */
  centre: Vec2;
  radius: number;
  /** arc starts at the latch point (leaf closed) … */
  from: Vec2;
  /** … and ends at the leaf tip (leaf open 90°) */
  to: Vec2;
  fromAngle: number;
  toAngle: number;
  /** true when the 90° sweep from `from` to `to` runs counter-clockwise in world coordinates */
  ccw: boolean;
}

/** How far a probe steps off the wall centreline to test which room a point is in */
export const PROBE_DEPTH = 0.06;
/** Latch-side switch offset along the wall beyond the opening (m) */
export const LATCH_OFFSET = 0.15;

interface Frame { dir: Vec2; leftN: Vec2; len: number; }

function frameOf(wall: WallRef): Frame {
  const dx = wall.end[0] - wall.start[0];
  const dy = wall.end[1] - wall.start[1];
  const len = Math.hypot(dx, dy) || 1;
  const dir: Vec2 = [dx / len, dy / len];
  return { dir, leftN: [-dir[1], dir[0]], len };
}

function at(wall: WallRef, f: Frame, t: number): Vec2 {
  return [wall.start[0] + f.dir[0] * t, wall.start[1] + f.dir[1] * t];
}

function inRect(r: Rect, p: Vec2, tol = 1e-6): boolean {
  return p[0] >= r.x - tol && p[0] <= r.x + r.w + tol && p[1] >= r.y - tol && p[1] <= r.y + r.h + tol;
}

/**
 * The `into` rect a producer should pass to `solveSwing`: `room` stretched perpendicular to `wall` until it reaches
 * half a probe depth PAST the wall centreline, so the 0.06 m probe answers "is the room on this side of the wall?" for
 * any wall thickness. Needed because a boundary wall's centreline sits outside the net room rect by thickness/2 (a
 * 0.2 m wet wall would otherwise put the probe inside the wall and outside every room). Axis-aligned walls only;
 * a diagonal wall gets the rect unchanged.
 */
export function reachRect(room: Rect, wall: WallRef): Rect {
  const f = frameOf(wall);
  const half = PROBE_DEPTH / 2;
  if (Math.abs(f.dir[1]) < 1e-6) {
    const line = wall.start[1];
    if (room.y + room.h / 2 >= line) {
      const y0 = Math.min(room.y, line + half);
      return { x: room.x, y: y0, w: room.w, h: room.y + room.h - y0 };
    }
    const y1 = Math.max(room.y + room.h, line - half);
    return { x: room.x, y: room.y, w: room.w, h: y1 - room.y };
  }
  if (Math.abs(f.dir[0]) < 1e-6) {
    const line = wall.start[0];
    if (room.x + room.w / 2 >= line) {
      const x0 = Math.min(room.x, line + half);
      return { x: x0, y: room.y, w: room.x + room.w - x0, h: room.h };
    }
    const x1 = Math.max(room.x + room.w, line - half);
    return { x: room.x, y: room.y, w: x1 - room.x, h: room.h };
  }
  return room;
}

/**
 * Where to hang a door of `width` in `wall` so that it actually opens into `room`: the centre of the wall's overlap
 * with the room, clamped clear of both ends. Falls back to the wall midpoint when the overlap is too short to hold
 * the leaf. The midpoint alone (v1's only rule) misses whenever the room covers just part of the wall — a core's
 * stair wall runs the whole depth of the core while the lift lobby is one bay of it.
 */
export function alongInWall(wall: WallRef, room: Rect, width: number): number {
  const f = frameOf(wall);
  const corners: Vec2[] = [
    [room.x, room.y], [room.x + room.w, room.y], [room.x + room.w, room.y + room.h], [room.x, room.y + room.h],
  ];
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of corners) {
    const t = (c[0] - wall.start[0]) * f.dir[0] + (c[1] - wall.start[1]) * f.dir[1];
    lo = Math.min(lo, t);
    hi = Math.max(hi, t);
  }
  lo = Math.max(lo, 0);
  hi = Math.min(hi, f.len);
  if (hi - lo < width + 0.2) return f.len / 2;
  const half = width / 2 + 0.1;
  return Math.min(Math.max((lo + hi) / 2, lo + half), hi - half);
}

/** Fraction of the leaf width, from the hinge toward the latch, at which the swing probe sits */
export const SWING_PROBE_ALONG = 0.3;

/**
 * The point every consumer and test probes to verify a swing: `SWING_PROBE_ALONG` of the leaf width from the hinge
 * toward the latch, then 0.05 m onto the swing side. It must lie inside `swingIntoRoomId`'s room rect. null for
 * motions that do not sweep a floor.
 */
export function swingProbe(d: DoorGeom, wall: WallRef): Vec2 | null {
  const n = swingNormal(d, wall);
  if (!n || !drawsArc(d)) return null;
  const h = hingePoint(d, wall);
  const l = latchPoint(d, wall);
  return [
    h[0] + (l[0] - h[0]) * SWING_PROBE_ALONG + n[0] * 0.05,
    h[1] + (l[1] - h[1]) * SWING_PROBE_ALONG + n[1] * 0.05,
  ];
}

/**
 * Derive hinge + swing from geometry. `into` is the world rect of the room the leaf must sweep into; `avoid` is a
 * world point the open leaf must stay clear of (centre of the wet-wall fixture run) — the hinge goes on the end of the
 * opening FARTHER from it, so the fully open leaf folds back onto the wall away from the fixtures.
 */
export function solveSwing(args: {
  wall: WallRef; along: number; width: number; motion: DoorMotion;
  into: Rect | null; avoid?: Vec2 | null; preferHinge?: DoorHinge; preferSwing?: DoorSwing;
}): SwingSolution {
  const f = frameOf(args.wall);
  const c = at(args.wall, f, args.along);
  let swing: DoorSwing;
  if (args.motion === 'rolling' || args.motion === 'opening') {
    swing = 'none';
  } else if (args.into) {
    const probe: Vec2 = [c[0] + f.leftN[0] * PROBE_DEPTH, c[1] + f.leftN[1] * PROBE_DEPTH];
    swing = inRect(args.into, probe) ? 'left' : 'right';
  } else {
    swing = args.preferSwing && args.preferSwing !== 'none' ? args.preferSwing : 'left';
  }
  let hinge: DoorHinge;
  if (args.avoid) {
    const t = (args.avoid[0] - args.wall.start[0]) * f.dir[0] + (args.avoid[1] - args.wall.start[1]) * f.dir[1];
    const s = args.along - args.width / 2;
    const e = args.along + args.width / 2;
    hinge = Math.abs(s - t) >= Math.abs(e - t) ? 'start' : 'end';
  } else {
    hinge = args.preferHinge ?? (args.along <= f.len / 2 ? 'start' : 'end');
  }
  return { hinge, swing };
}

export function hingePoint(d: DoorGeom, wall: WallRef): Vec2 {
  const f = frameOf(wall);
  const h = d.hinge ?? 'start';
  return at(wall, f, d.along + (h === 'start' ? -d.width / 2 : d.width / 2));
}

export function latchPoint(d: DoorGeom, wall: WallRef): Vec2 {
  const f = frameOf(wall);
  const h = d.hinge ?? 'start';
  return at(wall, f, d.along + (h === 'start' ? d.width / 2 : -d.width / 2));
}

/** Unit normal pointing to the side the leaf sweeps into; null for 'none' */
export function swingNormal(d: DoorGeom, wall: WallRef): Vec2 | null {
  const f = frameOf(wall);
  const s = d.swing ?? 'left';
  if (s === 'none') return null;
  return s === 'left' ? f.leftN : [-f.leftN[0], -f.leftN[1]];
}

/** Leaf tip when open 90° (hinge + swing normal × width) */
export function leafTip(d: DoorGeom, wall: WallRef): Vec2 {
  const h = hingePoint(d, wall);
  const n = swingNormal(d, wall) ?? frameOf(wall).leftN;
  return [h[0] + n[0] * d.width, h[1] + n[1] * d.width];
}

/** Only swing leaves draw an arc. Legacy doors without `motion` fall back to the IFC operation token. */
export function drawsArc(d: Pick<DoorGeom, 'motion' | 'operation'>): boolean {
  if (d.motion) return d.motion === 'swing' || d.motion === 'double-swing';
  const op = (d.operation ?? '').toUpperCase();
  return op.includes('SWING') && !op.includes('FIXED');
}

/** Quarter-square swing clearance in world XY (bbox of hinge, latch and their offsets on the swing side); null for non-swing motions */
export function swingRect(d: DoorGeom, wall: WallRef): Rect | null {
  if (!drawsArc(d)) return null;
  const n = swingNormal(d, wall);
  if (!n) return null;
  const h = hingePoint(d, wall);
  const l = latchPoint(d, wall);
  const pts: Vec2[] = [h, l, [h[0] + n[0] * d.width, h[1] + n[1] * d.width], [l[0] + n[0] * d.width, l[1] + n[1] * d.width]];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The 90° arc from the closed leaf (latch point) to the open leaf tip, centred on the hinge; null for non-swing motions */
export function swingArc(d: DoorGeom, wall: WallRef): SwingArc | null {
  if (!drawsArc(d)) return null;
  const centre = hingePoint(d, wall);
  const from = latchPoint(d, wall);
  const to = leafTip(d, wall);
  const ax = from[0] - centre[0], ay = from[1] - centre[1];
  const bx = to[0] - centre[0], by = to[1] - centre[1];
  return {
    centre, radius: d.width, from, to,
    fromAngle: Math.atan2(ay, ax), toAngle: Math.atan2(by, bx),
    ccw: ax * by - ay * bx > 0,
  };
}

/** Point just beyond the latch end of the opening, on the swing side — where the light switch goes (ELE-05) */
export function latchSide(d: DoorGeom, wall: WallRef): Vec2 {
  const h = hingePoint(d, wall);
  const l = latchPoint(d, wall);
  const dx = l[0] - h[0], dy = l[1] - h[1];
  const len = Math.hypot(dx, dy) || 1;
  const n = swingNormal(d, wall) ?? frameOf(wall).leftN;
  return [l[0] + (dx / len) * LATCH_OFFSET + n[0] * PROBE_DEPTH, l[1] + (dy / len) * LATCH_OFFSET + n[1] * PROBE_DEPTH];
}

/**
 * IFC4 IfcDoorTypeOperationEnum token, derived — never authored. An observer stands on the side the leaf does NOT
 * sweep into, looking through the opening: with dir = +X and swing 'left' (+Y) the observer is at −Y, so a hinge at the
 * 'start' (low-X) end is on the observer's LEFT. Hence LEFT ⇔ (swing === 'left') === (hinge === 'start').
 */
export function doorOperation(d: Pick<DoorGeom, 'motion' | 'hinge' | 'swing' | 'operation'>, leaves: 1 | 2 = 1): string {
  const motion = d.motion;
  if (!motion) return d.operation ?? 'NOTDEFINED';
  const hinge = d.hinge ?? 'start';
  const swing = d.swing ?? 'left';
  const token = (swing === 'left') === (hinge === 'start') ? 'LEFT' : 'RIGHT';
  switch (motion) {
    case 'swing': return leaves === 2 ? 'DOUBLE_DOOR_SINGLE_SWING' : `SINGLE_SWING_${token}`;
    case 'double-swing': return leaves === 2 ? 'DOUBLE_DOOR_DOUBLE_SWING' : `DOUBLE_SWING_${token}`;
    case 'sliding': return leaves === 2 ? 'DOUBLE_DOOR_SLIDING' : `SLIDING_TO_${token}`;
    case 'folding': return leaves === 2 ? 'DOUBLE_DOOR_FOLDING' : `FOLDING_TO_${token}`;
    case 'rolling': return 'ROLLINGUP';
    case 'opening': return 'NOTDEFINED';
    default: return 'NOTDEFINED';
  }
}

/** Minimum clear leaf width by door role (m). Program node minima are derived with leaf + 0.20 m so these always fit. */
export const LEAF_MIN: Readonly<Record<DoorDef['type'], number>> = {
  'unit-entry': 0.9, 'building-entry': 0.9, 'exit': 0.9, 'garage': 2.4, 'interior': 0.8, 'balcony': 0.8,
  'service': 0.8, 'closet': 0.7,
};
export const LEAF_MIN_BATH = 0.75;
export const LEAF_MIN_ACCESSIBLE = 0.85;
