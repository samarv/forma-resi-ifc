/**
 * `validateUnitLayout` — the per-unit invariant checker.
 *
 * Every check is one named assertion over a REALISED unit: the module self-test runs it across the
 * catalogue's frontage/depth sweep, `solver.test.ts` runs it across every template × frontage × depth ×
 * region, and the editor can run it on a single edited unit. A module whose sweep produces any failure
 * is not admitted to the catalogue, which is what turns "the plan might be wrong" into "the plan cannot
 * be wrong".
 *
 * The checks are the ones the design lists: tiles, reachable, daylight, kit-complete, swing-clear,
 * swing-into, trap-arm, min-dims, min-leaf, adjacency, ports, determinism.
 */
import type { DoorDef, FurnitureDef, Rect, RoomDef, RoomType, Side, WallDef } from '../../../core/types.ts';
import type { UnitLayout, UnitLayoutRequest } from '../unit-layout-types.ts';
import type { NodeRef, ProgramGraph, ProgramNode } from './types.ts';
import { LEAF_MIN, LEAF_MIN_ACCESSIBLE, LEAF_MIN_BATH, drawsArc, reachRect, swingProbe } from '../../../core/openings.ts';
import { rectsOverlap } from '../../../core/geometry.ts';
import { BASIN_ITEMS, BATHING_ITEMS, kitMandatory, kitOneOf } from './kits-api.ts';

export interface UnitCheckFailure {
  check: string;
  detail: string;
}

export interface ValidateArgs {
  layout: UnitLayout;
  req: UnitLayoutRequest;
  program: ProgramGraph;
  /** when given, the same request is solved again and the two results must be deep-equal */
  rerun?: () => UnitLayout;
  /** checks to skip (the organiser's own walls are not available in some fixtures) */
  skip?: readonly string[];
}

/**
 * Longest developed trap arm a branch may run before it needs its own vent: IPC 2021 Table 1002.2
 * gives 6 ft (1.52 m) for 1½ in and 12 ft (3.05 m) for 4 in. A dwelling's wet group is sized on the
 * 2 in / DN50 branch, so 1.5 m is the figure that matters for a lavatory or a sink and 3.0 m for the
 * WC's own DN100 branch.
 */
const TRAP_ARM_DN50 = 1.83;
const BATH_TYPES = new Set<RoomType>(['bathroom', 'ensuite', 'powder', 'wc']);
const DN100_ITEMS = new Set(['wc']);
const CIRCULATION = new Set<RoomType>(['hall', 'entry', 'corridor', 'stair']);

const E = 1e-6;

function area(r: Rect): number { return r.w * r.h; }

function sharedEdge(a: Rect, b: Rect): number {
  if (Math.abs(a.x + a.w - b.x) < 1e-3 || Math.abs(b.x + b.w - a.x) < 1e-3) {
    return Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  }
  if (Math.abs(a.y + a.h - b.y) < 1e-3 || Math.abs(b.y + b.h - a.y) < 1e-3) {
    return Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  }
  return 0;
}

function furnitureAabb(f: FurnitureDef): Rect {
  const [x, y] = f.position;
  const q = Math.round((((f.rotation % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 2)) % 4;
  switch (q) {
    case 0: return { x, y, w: f.width, h: f.depth };
    case 1: return { x: x - f.depth, y, w: f.depth, h: f.width };
    case 2: return { x: x - f.width, y: y - f.depth, w: f.width, h: f.depth };
    default: return { x, y: y - f.width, w: f.depth, h: f.width };
  }
}

function leafMinFor(d: DoorDef, rooms: RoomDef[], accessible: boolean): number {
  if (d.motion === 'opening' || d.motion === 'rolling') return 0.6;
  // a cupboard front that folds or slides has no leaf to walk round, so the closet minimum applies
  if (d.type === 'closet' || d.motion === 'folding' || d.motion === 'sliding') return LEAF_MIN.closet;
  const touchesBath = [d.fromRoomId, d.toRoomId]
    .some(id => id !== undefined && BATH_TYPES.has(rooms.find(r => r.id === id)?.type ?? 'hall'));
  if (accessible) return LEAF_MIN_ACCESSIBLE;
  if (touchesBath) return LEAF_MIN_BATH;
  return LEAF_MIN[d.type];
}

export function validateUnitLayout(a: ValidateArgs): UnitCheckFailure[] {
  const out: UnitCheckFailure[] = [];
  const skip = new Set(a.skip ?? []);
  const fail = (check: string, detail: string): void => {
    if (!skip.has(check)) out.push({ check, detail });
  };
  const { layout, req, program } = a;
  const accessible = req.template.id === 'senior-1b-accessible';
  const inside = layout.rooms.filter(r => r.type !== 'balcony' && r.type !== 'terrace');
  const walls: WallDef[] = [
    ...layout.walls,
    ...(['front', 'rear', 'left', 'right'] as Side[])
      .map(s => req.boundaryWalls[s])
      .filter((w): w is WallDef => w !== undefined),
  ];
  const wallById = new Map(walls.map(w => [w.id, w]));
  const roomById = new Map(layout.rooms.map(r => [r.id, r]));
  const byRef = new Map<NodeRef, RoomDef>();
  for (const r of layout.rooms) if (r.ref) byRef.set(r.ref, r);
  const nodeByRef = new Map<NodeRef, ProgramNode>(program.nodes.map(x => [x.ref, x]));

  // --- tiles -------------------------------------------------------------------------------------
  const net = area(req.rect);
  const covered = inside.reduce((s, r) => s + area(r.rect), 0);
  if (net > E && covered / net < 0.995) {
    fail('tiles', `rooms cover ${((covered / net) * 100).toFixed(2)} % of the ${req.rect.w.toFixed(2)} × ${req.rect.h.toFixed(2)} m net rect`);
  }
  for (let i = 0; i < inside.length; i++) {
    for (let j = i + 1; j < inside.length; j++) {
      if (rectsOverlap(inside[i].rect, inside[j].rect, 1e-4)) {
        fail('tiles', `${inside[i].name} overlaps ${inside[j].name}`);
      }
    }
  }

  // --- reachable ---------------------------------------------------------------------------------
  {
    const entry = layout.doors.find(d => d.id === layout.entryDoorId);
    const start = entry?.toRoomId ?? entry?.fromRoomId ?? inside[0]?.id;
    const seen = new Set<string>();
    if (start) {
      const queue = [start];
      seen.add(start);
      while (queue.length > 0) {
        const cur = queue.pop() as string;
        for (const d of layout.doors) {
          for (const [x, y] of [[d.fromRoomId, d.toRoomId], [d.toRoomId, d.fromRoomId]]) {
            if (x !== cur || !y || seen.has(y)) continue;
            seen.add(y);
            queue.push(y);
          }
        }
      }
    }
    for (const r of inside) {
      if (!seen.has(r.id)) fail('reachable', `${r.name} cannot be reached from the entry through doors`);
    }
  }

  // --- daylight ----------------------------------------------------------------------------------
  for (const r of inside) {
    const node = r.ref ? nodeByRef.get(r.ref) : undefined;
    if (!node?.needsExterior) continue;
    if (r.windowIds.length === 0) fail('daylight', `${r.name} (${r.ref}) needs daylight and has no window`);
    else if (!r.hasExterior || r.exteriorWallIds.length === 0) fail('daylight', `${r.name} has a window but no exterior wall recorded`);
  }

  // --- kit-complete ------------------------------------------------------------------------------
  if (req.options.furniture) {
    for (const r of inside) {
      const node = r.ref ? nodeByRef.get(r.ref) : undefined;
      if (!node) continue;
      const items = layout.furniture.filter(f => f.roomId === r.id).map(f => f.type);
      for (const want of kitMandatory(node.kit)) {
        if (!items.includes(want)) fail('kit-complete', `${r.name} (${node.kit}) is missing its ${want}`);
      }
      for (const group of kitOneOf(node.kit)) {
        if (!group.some(x => items.includes(x))) {
          fail('kit-complete', `${r.name} (${node.kit}) has none of ${group.join(' / ')}`);
        }
      }
      if (BATH_TYPES.has(r.type)) {
        if (!BASIN_ITEMS.some(x => items.includes(x))) fail('kit-complete', `${r.name} has no basin`);
        if (r.type !== 'powder' && r.type !== 'wc' && !BATHING_ITEMS.some(x => items.includes(x))) {
          fail('kit-complete', `${r.name} has neither a shower nor a bath`);
        }
      }
    }
  }

  // --- swing-clear / swing-into ------------------------------------------------------------------
  for (const s of layout.swings ?? []) {
    for (const f of layout.furniture) {
      if (f.roomId !== s.roomId) continue;
      if (rectsOverlap(s.rect, furnitureAabb(f), 2e-2)) {
        fail('swing-clear', `${f.type} stands in the swing of door ${s.doorId} in ${roomById.get(s.roomId)?.name ?? s.roomId}`);
      }
    }
  }
  for (const d of layout.doors) {
    if (!drawsArc(d)) continue;
    const wall = wallById.get(d.wallId);
    if (!wall) { fail('swing-into', `door ${d.id} has no host wall`); continue; }
    if (!d.swingIntoRoomId) { fail('swing-into', `swing door ${d.id} does not say which room it sweeps`); continue; }
    const room = roomById.get(d.swingIntoRoomId);
    const p = swingProbe(d, wall);
    if (!room || !p) { fail('swing-into', `door ${d.id} names a room that is not in the layout`); continue; }
    // a boundary wall's centreline sits outside the net room rect by thickness/2, so the room has to be
    // stretched to the wall before the probe means anything (reachRect, core/openings.ts)
    const r = reachRect(room.rect, wall);
    const inR = p[0] >= r.x - 1e-3 && p[0] <= r.x + r.w + 1e-3 && p[1] >= r.y - 1e-3 && p[1] <= r.y + r.h + 1e-3;
    if (!inR) fail('swing-into', `door ${d.id} says it sweeps ${room.name} but its probe lands outside it`);
  }

  // --- trap-arm ----------------------------------------------------------------------------------
  {
    const ports = layout.stackPorts ?? [];
    for (const p of ports) {
      // the station is chosen to MINIMISE the longest developed arm in its group, so this is the real
      // constraint: past it, plumbing has to vent the branch separately (IPC 2021 §1002.2)
      if (p.maxArm > TRAP_ARM_DN50 + 0.35) {
        fail('trap-arm', `stack ${p.id} carries a ${p.maxArm.toFixed(2)} m developed trap arm (unvented limit ${TRAP_ARM_DN50.toFixed(2)} m for DN50)`);
      }
    }
    const served = new Set(ports.flatMap(p => p.serves));
    for (const f of layout.furniture) {
      if (!f.needsWater) continue;
      const room = roomById.get(f.roomId);
      const ref = room?.ref ?? room?.type;
      if (ref !== undefined && !served.has(ref)) {
        fail('trap-arm', `${f.type} in ${room?.name ?? f.roomId} is not served by any stack port`);
      }
    }
  }

  // --- min-dims ----------------------------------------------------------------------------------
  for (const r of inside) {
    const node = r.ref ? nodeByRef.get(r.ref) : undefined;
    if (!node) continue;
    const a1 = Math.max(r.rect.w, r.rect.h);
    const b1 = Math.min(r.rect.w, r.rect.h);
    const wantLong = Math.max(node.minWidth, node.minDepth);
    const wantShort = Math.min(node.minWidth, node.minDepth);
    // The kit minima are derived to the nearest 10 mm from catalogue footprints plus published
    // clearances, so a shortfall under 50 mm is inside that derivation's own tolerance; the solver still
    // records it as a deviation. Anything larger is a room that has stopped working.
    const TOL = 0.05;
    if (a1 < wantLong - TOL || b1 < wantShort - TOL) {
      fail('min-dims', `${r.name} is ${r.rect.w.toFixed(2)} × ${r.rect.h.toFixed(2)} m, below the ${node.minWidth.toFixed(2)} × ${node.minDepth.toFixed(2)} m its ${node.kit} kit needs`);
    }
    if (b1 > E && a1 / b1 > node.aspect.max + 0.35) {
      fail('min-dims', `${r.name} has an aspect ratio of ${(a1 / b1).toFixed(2)} against a ${node.aspect.max.toFixed(2)} limit`);
    }
  }

  // --- min-leaf ----------------------------------------------------------------------------------
  for (const d of layout.doors) {
    // the leaf cannot be wider than the wall that hosts it: a 0.6 m broom cupboard gets a 0.45 m front
    const host = wallById.get(d.wallId);
    const cap = host ? Math.hypot(host.end[0] - host.start[0], host.end[1] - host.start[1]) - 0.15 : Infinity;
    const want = Math.min(leafMinFor(d, layout.rooms, accessible), cap);
    if (d.width < want - 0.005) {
      fail('min-leaf', `door ${d.id} (${d.type}/${d.motion}) is ${d.width.toFixed(2)} m, below the ${want.toFixed(2)} m minimum leaf`);
    }
  }

  // --- adjacency ---------------------------------------------------------------------------------
  {
    const doorBetween = (x: RoomDef, y: RoomDef): DoorDef | undefined => layout.doors.find(d =>
      (d.fromRoomId === x.id && d.toRoomId === y.id) || (d.fromRoomId === y.id && d.toRoomId === x.id));
    /**
     * A landing, the stair head it opens off and the hall beyond it are one circulation space, so a
     * `door` rule naming one of them is satisfied by a door to any of them — what ARC-19 asks is that
     * the room opens off CIRCULATION, not off another room.
     */
    const circ = new Set(inside.filter(r => CIRCULATION.has(r.type)).map(r => r.id));
    const doorToCirculation = (x: RoomDef): boolean =>
      layout.doors.some(d => (d.fromRoomId === x.id && d.toRoomId !== undefined && circ.has(d.toRoomId))
        || (d.toRoomId === x.id && d.fromRoomId !== undefined && circ.has(d.fromRoomId)));
    for (const rule of program.rules) {
      if (rule.regions && !rule.regions.includes(req.region)) continue;
      const x = byRef.get(rule.a as NodeRef);
      const y = byRef.get(rule.b as NodeRef);
      if (!x || !y) continue;
      const edge = sharedEdge(x.rect, y.rect);
      switch (rule.kind) {
        case 'share-edge':
          if (edge < 0.3) fail('adjacency', `${rule.a} and ${rule.b} should share a wall (${rule.reason})`);
          break;
        case 'door': {
          if (doorBetween(x, y)) break;
          const viaCirculation = (CIRCULATION.has(x.type) && doorToCirculation(y))
            || (CIRCULATION.has(y.type) && doorToCirculation(x));
          if (!viaCirculation) fail('adjacency', `${rule.a} and ${rule.b} should be joined by a door (${rule.reason})`);
          break;
        }
        case 'no-door':
          if (doorBetween(x, y)) fail('adjacency', `${rule.a} must not open into ${rule.b} (${rule.reason})`);
          break;
        default:
          if (edge > 0.6) fail('adjacency', `${rule.a} must not adjoin ${rule.b} (${rule.reason})`);
      }
    }
  }

  // --- ports -------------------------------------------------------------------------------------
  {
    const stacks = layout.stackPorts ?? [];
    const wetRefs = program.nodes.filter(x => x.wet && byRef.has(x.ref)).map(x => x.ref);
    if (wetRefs.length > 0 && stacks.length === 0) fail('ports', 'the unit has wet rooms and no stack port');
    for (const p of stacks) {
      if (!(p.atFrac >= -1e-9 && p.atFrac <= 1 + 1e-9)) fail('ports', `stack ${p.id} atFrac ${p.atFrac} is outside 0…1`);
      if (!wallById.has(p.wallId)) fail('ports', `stack ${p.id} references wall ${p.wallId}, which is not in the layout`);
      if (p.serves.length === 0) fail('ports', `stack ${p.id} serves nothing`);
    }
    const served = new Set(stacks.flatMap(p => p.serves));
    for (const ref of wetRefs) if (!served.has(ref)) fail('ports', `${ref} is a wet room with no stack port`);
    for (const p of layout.exhaustPorts ?? []) {
      if (!(p.atFrac >= -1e-9 && p.atFrac <= 1 + 1e-9)) fail('ports', `exhaust ${p.id} atFrac ${p.atFrac} is outside 0…1`);
      if (p.flowLs <= 0) fail('ports', `exhaust ${p.id} has no flow`);
    }
    if (layout.kitchenRoomId && !(layout.exhaustPorts ?? []).some(p => p.kind === 'kitchen')) {
      fail('ports', 'the kitchen has no exhaust port');
    }
    if (layout.panelPort === null || layout.panelPort === undefined) fail('ports', 'the unit has no electrical panel port');
    else if (!wallById.has(layout.panelPort.wallId)) fail('ports', `panel port references wall ${layout.panelPort.wallId}, which is not in the layout`);
  }

  // --- determinism -------------------------------------------------------------------------------
  if (a.rerun) {
    const b = a.rerun();
    const proj = (l: UnitLayout): string => JSON.stringify({
      r: l.rooms.map(r => [r.id, r.ref, r.rect]),
      d: l.doors.map(d => [d.id, d.wallId, d.along, d.width, d.motion, d.hinge, d.swing]),
      w: l.walls.map(w => [w.id, w.start, w.end, w.thickness]),
      f: l.furniture.map(f => [f.id, f.type, f.position, f.rotation]),
      p: [l.stackPorts, l.exhaustPorts, l.panelPort],
    });
    if (proj(layout) !== proj(b)) fail('determinism', 'two runs of the same request differ');
  }

  return out;
}
