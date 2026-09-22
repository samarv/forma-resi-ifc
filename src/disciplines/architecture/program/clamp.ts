/**
 * `clampUnitEdit` — the one function that decides what an in-unit edit is allowed to be.
 *
 * The editor calls it to draw its ghost and its rail; `applyOverrides` calls it before forwarding the
 * edit to the solver. Because it is the SAME function, the ghost the user drags and the model that
 * comes back cannot disagree — which is the whole correctness argument for direct manipulation.
 *
 * Contract (F5c): **total** (never throws, whatever it is handed), **pure**, **idempotent**
 * (`clamp(clamp(e)) === clamp(e)`), and `range` is the admissible closed interval of the edit's scalar
 * so the overlay can draw a rail even when the pointer is outside it. `ok: false` with a `reason` when
 * no legal value exists at all.
 *
 * In-unit refs are program-node refs, never minted element ids: room `bedroom2`, door `entry1~hall1`,
 * partition `refA|refB` (sorted), furniture `roomRef#kitSlot`.
 */
import type { FurnitureDef, Rect, RoomDef, RoomType, Vec2, WallDef } from '../../../core/types.ts';
import type { UnitEdit } from '../../../core/overrides.ts';
import type { ClampCtx, ClampResult } from '../placer/types.ts';
import type { UnitLayout } from '../unit-layout-types.ts';
import type { NodeRef, ProgramGraph, ProgramNode } from './types.ts';
import { rectsOverlap } from '../../../core/geometry.ts';
import { FURNITURE_CATALOG } from '../furniture.ts';
import { fitKit, kitMandatory, kitMinDims } from './kits-api.ts';

const E = 1e-6;
const clampTo = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
/** every committed scalar is a multiple of 5 mm, so reruns stay byte-identical */
const QUANTUM = 0.005;
const quant = (v: number): number => Math.round(v / QUANTUM) * QUANTUM;
const BATH_TYPES = new Set<RoomType>(['bathroom', 'ensuite', 'powder', 'wc']);
/** Room types a dwelling room may be swapped to — every one of them has a furniture kit to fit. */
const SWAPPABLE = new Set<RoomType>([
  'living', 'dining', 'kitchen', 'living-kitchen', 'bedroom', 'master-bedroom', 'bathroom', 'ensuite',
  'powder', 'wc', 'study', 'den', 'flex', 'hall', 'entry', 'closet', 'walk-in-closet', 'laundry',
  'utility', 'storage',
]);

function ok<E2 extends UnitEdit>(edit: E2, range?: [number, number]): ClampResult<E2> {
  return range ? { edit, ok: true, range } : { edit, ok: true };
}
function no<E2 extends UnitEdit>(edit: E2, reason: string, range?: [number, number]): ClampResult<E2> {
  return range ? { edit, ok: false, reason, range } : { edit, ok: false, reason };
}

function wallsOf(layout: UnitLayout): WallDef[] {
  return layout.walls;
}

function wallLen(w: WallDef): number {
  return Math.hypot(w.end[0] - w.start[0], w.end[1] - w.start[1]);
}

function roomByRef(layout: UnitLayout, ref: string): RoomDef | undefined {
  return layout.rooms.find(r => (r.ref ?? r.type) === ref);
}

function nodeOf(program: ProgramGraph, ref: NodeRef): ProgramNode | undefined {
  return program.nodes.find(x => x.ref === ref);
}

/** `refA|refB` → the interior wall between those two rooms. */
function partitionOf(layout: UnitLayout, edgeRef: string): { wall: WallDef; a: RoomDef; b: RoomDef } | null {
  const parts = edgeRef.split('|');
  if (parts.length !== 2) return null;
  const a = roomByRef(layout, parts[0]);
  const b = roomByRef(layout, parts[1]);
  if (!a || !b) return null;
  const wall = wallsOf(layout).find(w =>
    (w.leftRoomId === a.id && w.rightRoomId === b.id) || (w.leftRoomId === b.id && w.rightRoomId === a.id));
  if (!wall) return null;
  return { wall, a, b };
}

/**
 * The door and, when the unit owns it, its host wall. A door in a BOUNDARY wall (the unit entry, a
 * balcony slider) is hosted by a wall the floor organiser owns: its hinge and motion are still the
 * unit's to edit, but its position along the wall is not.
 */
function doorByRef(layout: UnitLayout, ref: string): { door: (typeof layout.doors)[number]; wall: WallDef | null } | null {
  const door = layout.doors.find(d => (d.ref ?? '') === ref) ?? layout.doors.find(d => d.id === ref);
  if (!door) return null;
  return { door, wall: wallsOf(layout).find(w => w.id === door.wallId) ?? null };
}

function furnitureByRef(layout: UnitLayout, ref: string): FurnitureDef | undefined {
  return layout.furniture.find(f => (f.ref ?? '') === ref) ?? layout.furniture.find(f => f.id === ref);
}

function aabbOf(f: FurnitureDef, at: Vec2 = f.position, rotation = f.rotation): Rect {
  const q = Math.round((((rotation % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 2)) % 4;
  const [x, y] = at;
  switch (q) {
    case 0: return { x, y, w: f.width, h: f.depth };
    case 1: return { x: x - f.depth, y, w: f.depth, h: f.width };
    case 2: return { x: x - f.width, y: y - f.depth, w: f.width, h: f.depth };
    default: return { x, y: y - f.width, w: f.depth, h: f.width };
  }
}

function contains(outer: Rect, inner: Rect, tol = 1e-3): boolean {
  return inner.x >= outer.x - tol && inner.y >= outer.y - tol
    && inner.x + inner.w <= outer.x + outer.w + tol && inner.y + inner.h <= outer.y + outer.h + tol;
}

/**
 * Total, pure, idempotent clamp of one in-unit edit.
 *
 * - `dragPartition`   — the signed normal offset, bounded by both rooms' program minima (and by their
 *                       furniture kits still fitting) on either side.
 * - `moveDoor`        — the along-wall position, bounded by the free spans of the host wall with half a
 *                       leaf plus a 0.15 m reveal at each end.
 * - `flipDoor` / `reverseDoor` / `setDoorMotion` — admissible whenever the door exists; a swing motion
 *                       additionally needs a room that can hold the leaf.
 * - `moveFurniture`   — the offset, bounded by the room minus the door-swing keep-outs and the other
 *                       items.
 * - `addFurniture`    — a clear position inside the room.
 * - `removeFurniture` — refused for an item its room's kit declares mandatory.
 * - `swapRoomType`    — only to a type whose kit fits the existing rect.
 */
export function clampUnitEdit(
  unitLayout: UnitLayout,
  edit: UnitEdit,
  program: ProgramGraph,
  ctx: ClampCtx,
): ClampResult<UnitEdit> {
  try {
    return clampInner(unitLayout, edit, program, ctx);
  } catch (err) {
    // total by contract: an unexpected shape of input is a refusal, never a throw
    return no(edit, `edit could not be evaluated: ${(err as Error).message}`);
  }
}

function clampInner(
  layout: UnitLayout,
  edit: UnitEdit,
  program: ProgramGraph,
  ctx: ClampCtx,
): ClampResult<UnitEdit> {
  switch (edit.op) {
    // --- doors ---------------------------------------------------------------------------------
    case 'flipDoor':
    case 'reverseDoor': {
      const d = doorByRef(layout, edit.doorRef);
      if (!d) return no(edit, `no door ${edit.doorRef} in this unit`);
      if (d.door.motion !== 'swing' && d.door.motion !== 'double-swing') {
        return no(edit, `door ${edit.doorRef} has no leaf to ${edit.op === 'flipDoor' ? 'flip' : 'reverse'} (motion ${d.door.motion})`);
      }
      return ok(edit);
    }
    case 'setDoorMotion': {
      const d = doorByRef(layout, edit.doorRef);
      if (!d) return no(edit, `no door ${edit.doorRef} in this unit`);
      if (edit.motion === 'swing' || edit.motion === 'double-swing') {
        const rooms = [d.door.fromRoomId, d.door.toRoomId]
          .map(id => layout.rooms.find(r => r.id === id))
          .filter((r): r is RoomDef => r !== undefined);
        const canHold = rooms.some(r => Math.min(r.rect.w, r.rect.h) >= d.door.width + 0.15);
        if (!canHold) return no(edit, `neither room can hold a ${d.door.width.toFixed(2)} m leaf; keep it sliding`);
      }
      return ok(edit);
    }
    case 'moveDoor': {
      const d = doorByRef(layout, edit.doorRef);
      if (!d) return no(edit, `no door ${edit.doorRef} in this unit`);
      if (!d.wall) {
        return no(edit, `door ${edit.doorRef} is hosted in a boundary wall the floor layout owns; move the slot instead`);
      }
      const len = wallLen(d.wall);
      const half = d.door.width / 2;
      const margin = 0.15;
      // the free spans of this wall are what is left once the other openings on it are removed
      const wall = d.wall;
      const taken = [...layout.doors, ...layout.windows]
        .filter(o => o.wallId === wall.id && o.id !== d.door.id)
        .map(o => ({ a: o.along - o.width / 2 - margin, b: o.along + o.width / 2 + margin }))
        .sort((x, y) => x.a - y.a);
      const lo = half + margin;
      const hi = Math.max(lo, len - half - margin);
      const spans: [number, number][] = [];
      let cur = lo;
      for (const t of taken) {
        if (t.a - half > cur) spans.push([cur, Math.min(hi, t.a - half)]);
        cur = Math.max(cur, t.b + half);
      }
      if (cur <= hi) spans.push([cur, hi]);
      const valid = spans.filter(s => s[1] >= s[0] - E);
      if (valid.length === 0) return no(edit, `wall ${wall.id} has no free span for a ${d.door.width.toFixed(2)} m leaf`, [lo, hi]);
      const best = valid.reduce((acc, s) => {
        const v = clampTo(edit.along, s[0], s[1]);
        return Math.abs(v - edit.along) < Math.abs(acc.v - edit.along) ? { v, s } : acc;
      }, { v: clampTo(edit.along, valid[0][0], valid[0][1]), s: valid[0] });
      const along = quant(clampTo(best.v, best.s[0], best.s[1]));
      return ok({ ...edit, along }, [best.s[0], best.s[1]]);
    }

    // --- partitions ----------------------------------------------------------------------------
    case 'dragPartition': {
      const p = partitionOf(layout, edit.edgeRef);
      if (!p) return no(edit, `no partition ${edit.edgeRef} in this unit`);
      const horizontal = Math.abs(p.wall.end[1] - p.wall.start[1]) < 1e-6;
      // which room loses when delta is positive: the one on the low side of the moving axis
      const axis = horizontal ? 'y' : 'x';
      const sizeOf = (r: RoomDef): number => (axis === 'y' ? r.rect.h : r.rect.w);
      const lowFirst = (axis === 'y' ? p.a.rect.y < p.b.rect.y : p.a.rect.x < p.b.rect.x);
      const low = lowFirst ? p.a : p.b;
      const high = lowFirst ? p.b : p.a;
      const floorOf = (r: RoomDef): number => {
        const node = r.ref ? nodeOf(program, r.ref) : undefined;
        if (!node) return 0.9;
        const kit = kitMinDims(node.kit);
        const across = axis === 'y' ? r.rect.w : r.rect.h;
        // the dimension being dragged must still clear the kit in one of its two orientations
        return across >= Math.max(kit.w, kit.d) - 1e-3 ? Math.min(kit.w, kit.d) : Math.max(kit.w, kit.d);
      };
      const maxGive = Math.max(0, sizeOf(low) - floorOf(low));
      const maxTake = Math.max(0, sizeOf(high) - floorOf(high));
      const range: [number, number] = [-quant(maxGive), quant(maxTake)];
      if (range[0] > -QUANTUM && range[1] < QUANTUM) {
        return no(edit, `${low.name} and ${high.name} are both already at their minimum clear dimension`, range);
      }
      const delta = quant(clampTo(edit.delta, range[0], range[1]));
      if (Math.abs(delta) < E) return no(edit, 'the partition is already at that position', range);
      return ok({ ...edit, delta }, range);
    }

    // --- furniture -----------------------------------------------------------------------------
    case 'moveFurniture': {
      const f = furnitureByRef(layout, edit.itemRef);
      if (!f) return no(edit, `no furniture ${edit.itemRef} in this unit`);
      const room = layout.rooms.find(r => r.id === f.roomId);
      if (!room) return no(edit, `${edit.itemRef} has no room`);
      const rotation = edit.rotate === undefined ? f.rotation : Math.round(edit.rotate / (Math.PI / 2)) * (Math.PI / 2);
      const swings = (layout.swings ?? []).filter(s => s.roomId === room.id).map(s => s.rect);
      const others = layout.furniture.filter(o => o.roomId === room.id && o.id !== f.id).map(o => aabbOf(o));
      const tryAt = (du: number, dv: number): boolean => {
        const box = aabbOf(f, [f.position[0] + du, f.position[1] + dv], rotation);
        if (!contains(room.rect, box, 5e-3)) return false;
        return !swings.some(s => rectsOverlap(s, box, 2e-2)) && !others.some(o => rectsOverlap(o, box, 1e-3));
      };
      const du0 = quant(edit.du);
      const dv0 = quant(edit.dv);
      if (tryAt(du0, dv0)) return ok({ ...edit, du: du0, dv: dv0, ...(edit.rotate === undefined ? {} : { rotate: rotation }) });
      // walk back toward the current position in 5 mm steps — the nearest legal offset on the ray
      const steps = Math.ceil(Math.hypot(du0, dv0) / QUANTUM);
      for (let k = steps - 1; k >= 0; k--) {
        const t = k / Math.max(steps, 1);
        const du = quant(du0 * t);
        const dv = quant(dv0 * t);
        if (tryAt(du, dv)) {
          return ok({ ...edit, du, dv, ...(edit.rotate === undefined ? {} : { rotate: rotation }) },
            [0, Math.hypot(du, dv)]);
        }
      }
      return no(edit, `${f.type} cannot move there: the room, a door swing or another item is in the way`, [0, 0]);
    }
    case 'addFurniture': {
      const room = roomByRef(layout, edit.roomRef);
      if (!room) return no(edit, `no room ${edit.roomRef} in this unit`);
      const spec = FURNITURE_CATALOG[edit.type];
      if (!spec) return no(edit, `${edit.type} is not in the furniture catalogue`);
      const rotation = Math.round(edit.rotation / (Math.PI / 2)) * (Math.PI / 2);
      const ghost = { id: '', storey: '', roomId: room.id, type: edit.type, position: [0, 0] as Vec2, width: spec.w, depth: spec.d, height: spec.h, rotation } as FurnitureDef;
      const u = quant(clampTo(edit.u, room.rect.x, room.rect.x + room.rect.w));
      const v = quant(clampTo(edit.v, room.rect.y, room.rect.y + room.rect.h));
      const box = aabbOf(ghost, [u, v], rotation);
      if (!contains(room.rect, box, 5e-3)) return no(edit, `a ${edit.type} does not fit inside ${room.name} there`);
      const swings = (layout.swings ?? []).filter(s => s.roomId === room.id).map(s => s.rect);
      const others = layout.furniture.filter(o => o.roomId === room.id).map(o => aabbOf(o));
      if (swings.some(s => rectsOverlap(s, box, 2e-2))) return no(edit, `that position is inside a door swing`);
      if (others.some(o => rectsOverlap(o, box, 1e-3))) return no(edit, `that position is already occupied`);
      return ok({ ...edit, u, v, rotation });
    }
    case 'removeFurniture': {
      const f = furnitureByRef(layout, edit.itemRef);
      if (!f) return no(edit, `no furniture ${edit.itemRef} in this unit`);
      const room = layout.rooms.find(r => r.id === f.roomId);
      const node = room?.ref ? nodeOf(program, room.ref) : undefined;
      if (node) {
        if (kitMandatory(node.kit).includes(f.type)) {
          return no(edit, `${f.type} is part of the ${node.kit} kit: removing it would leave ${room?.name ?? 'the room'} incomplete`);
        }
      }
      return ok(edit);
    }

    // --- room type -----------------------------------------------------------------------------
    case 'swapRoomType': {
      const room = roomByRef(layout, edit.roomRef);
      if (!room) return no(edit, `no room ${edit.roomRef} in this unit`);
      const node = room.ref ? nodeOf(program, room.ref) : undefined;
      if (!SWAPPABLE.has(edit.type)) return no(edit, `${edit.type} is not a dwelling room type`);
      const kit = kitFor(edit.type, node);
      const local: Rect = { x: 0, y: 0, w: room.rect.w, h: room.rect.h };
      const fits = fitKit(local, kit, []);
      if (!fits.ok) return no(edit, `a ${edit.type} does not fit ${room.name}: ${fits.reason ?? 'too small'}`);
      if (BATH_TYPES.has(edit.type) && !node?.wet) {
        return no(edit, `${room.name} is not on a wet wall, so it cannot become a ${edit.type}`);
      }
      return ok(edit);
    }
    default:
      return no(edit, 'unknown edit');
  }
}

/** The kit a swapped room type would need — the node's own kit when the type is unchanged. */
function kitFor(type: RoomType, node: ProgramNode | undefined): Parameters<typeof kitMinDims>[0] {
  if (node && node.type === type) return node.kit;
  switch (type) {
    case 'bedroom': return 'bed-double';
    case 'master-bedroom': return 'bed-master';
    case 'living': return 'living-3seat';
    case 'living-kitchen': return 'living-kitchen';
    case 'dining': return 'dining-4';
    case 'kitchen': return 'kitchen-galley';
    case 'bathroom': return 'bath-3pc-tub';
    case 'ensuite': return 'bath-3pc-shower';
    case 'powder':
    case 'wc': return 'wc-2pc';
    case 'study':
    case 'den': return 'desk';
    case 'laundry':
    case 'utility': return 'laundry-stack';
    case 'walk-in-closet': return 'wardrobe-run';
    case 'closet':
    case 'storage': return 'shelf';
    case 'entry': return 'entry';
    case 'garage': return 'garage-1car';
    default: return 'none';
  }
}
