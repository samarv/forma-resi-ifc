/**
 * Unit layout engine tests: every one of the 20 templates, on every level, inside a typical NET
 * rect, with synthetic boundary walls standing in for the floor organizer's party / corridor /
 * exterior walls.
 *
 * Invariants asserted per template and level:
 *  - rooms tile the net rect (≥ 92 % coverage) with no pairwise overlap
 *  - every room (except the balcony) sits inside the net rect
 *  - every room whose program asks for daylight has at least one window
 *  - every room has at least one door
 *  - the unit entry door lies inside the access boundary wall
 *  - no two openings overlap on any one wall
 *  - furniture sits inside its room and never overlaps other furniture
 *  - the wet wall set is non-empty and bounds both the kitchen and a bathroom
 *  - multi-level templates return an identical stair rect on every level
 *  - ids are unique and no coordinate is NaN
 *  - all 20 templates lay out in under 50 ms in total
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type {
  Compass, DoorDef, FurnitureDef, Rect, Region, RoomDef, Side, UnitTemplateDef, UnitTemplateId,
  Vec2, WallDef, WindowDef, GenerationOptions,
} from '../../core/types.ts';
import type { UnitBoundaryWalls, UnitLayout, UnitLayoutFn, UnitLayoutRequest } from './unit-layout-types.ts';
import { layoutUnitV2 } from './program/solver.ts';
import { UNIT_TEMPLATES, recommendedRect, programArea } from './templates.ts';
import { UNIT_PATTERNS } from './unit-patterns.ts';
import { FURNITURE_CATALOG } from './furniture.ts';
import { UNIT_TEMPLATE_IDS } from '../../core/spec.ts';
import { createRng } from '../../core/rng.ts';
import { SIZES } from '../../core/coordination.ts';
import { rectsOverlap, rectContainsRect } from '../../core/geometry.ts';

// ---------------------------------------------------------------------------
// Fixture: a unit rect with one boundary wall per side, centreline offset outward
// ---------------------------------------------------------------------------

/** Templates that are own-door houses: daylight on all four sides, no balcony. */
const HOUSES = new Set(['maisonette-2s', 'townhouse-2s', 'townhouse-3s', 'ranch-3b', 'colonial-4b', 'adu-1b']);

function exteriorFor(id: string): Side[] {
  if (HOUSES.has(id)) return ['front', 'rear', 'left', 'right'];
  if (id === 'corner-2b2b') return ['rear', 'left'];
  if (id === 'coliving-cluster') return ['rear', 'left', 'right'];
  return ['rear'];
}

function boundaryWalls(rect: Rect, access: Side, ext: Side[], storey: string): UnitBoundaryWalls {
  // an own-door house is entered through its own exterior wall; a flat through a corridor wall
  const kind = (s: Side): WallDef['type'] => (ext.includes(s) ? 'exterior' : s === access ? 'corridor' : 'party');
  const th = (s: Side): number => (ext.includes(s) ? SIZES.exteriorWallT : s === access ? SIZES.corridorWallT : SIZES.partyWallT);
  const mk = (s: Side, a: Vec2, b: Vec2): WallDef => ({
    id: `ORG-${storey}-${s.toUpperCase()}`,
    storey,
    start: a,
    end: b,
    thickness: th(s),
    height: 2.8,
    type: kind(s),
    isExternal: kind(s) === 'exterior',
    loadBearingHint: kind(s) !== 'partition',
    fireRating: kind(s) === 'party' || kind(s) === 'corridor' ? '1HR' : undefined,
  });
  const x0 = rect.x;
  const y0 = rect.y;
  const x1 = rect.x + rect.w;
  const y1 = rect.y + rect.h;
  // centrelines lie thickness/2 OUTSIDE the net rect; each wall runs CCW around the unit
  return {
    front: mk('front', [x0, y0 - th('front') / 2], [x1, y0 - th('front') / 2]),
    right: mk('right', [x1 + th('right') / 2, y0], [x1 + th('right') / 2, y1]),
    rear: mk('rear', [x1, y1 + th('rear') / 2], [x0, y1 + th('rear') / 2]),
    left: mk('left', [x0 - th('left') / 2, y1], [x0 - th('left') / 2, y0]),
  };
}

const OPTIONS: GenerationOptions = {
  furniture: true, site: true, structure: true, mechanical: true, plumbing: true, electrical: true,
  detail: 'high', ifcSchema: 'IFC4',
};

function makeRequest(t: UnitTemplateDef, level: number, region: Region = 'US'): UnitLayoutRequest {
  const { frontage, depth } = recommendedRect(t.id);
  const rect: Rect = { x: 12, y: 7, w: frontage, h: depth };
  const ext = exteriorFor(t.id);
  const storey = `L0${level + 1}`;
  const apartment = !HOUSES.has(t.id) && t.id !== 'coliving-cluster';
  return {
    unitId: 'U-L01-04',
    template: t,
    rect,
    storey,
    level,
    levelsTotal: t.storeysInUnit,
    accessSide: 'front',
    exteriorSides: ext,
    exposures: { front: 'N', rear: 'S', left: 'E', right: 'W' },
    boundaryWalls: boundaryWalls(rect, 'front', ext, storey),
    floorToFloor: 3.0,
    ceilingHeight: 2.7,
    wwr: 0.35,
    balcony: apartment ? { side: 'rear', depth: 1.8 } : null,
    region,
    options: OPTIONS,
    rng: createRng(1),
    wetWallSide: 'front',
    stackAlong: Math.min(1.4, frontage * 0.25),
  };
}

/**
 * A dwelling entered from a stair landing on its side: the access wall is a corridor wall, the
 * side opposite it is a party wall, and the sides handed in `ext` are exterior (ARC-36).
 */
function makeSideEntryRequest(o: {
  templateId: UnitTemplateId;
  rect: Rect;
  access: Side;
  ext: Side[];
  exposures: Partial<Record<Side, Compass>>;
  region?: Region;
  wwr?: number;
  floorToFloor?: number;
  balcony?: { side: Side; depth: number } | null;
}): UnitLayoutRequest {
  const t = UNIT_TEMPLATES[o.templateId];
  const f2f = o.floorToFloor ?? 3.0;
  return {
    unitId: 'U-L01-02',
    template: t,
    rect: o.rect,
    storey: 'L01',
    level: 0,
    levelsTotal: t.storeysInUnit,
    accessSide: o.access,
    exteriorSides: o.ext,
    exposures: o.exposures,
    boundaryWalls: boundaryWalls(o.rect, o.access, o.ext, 'L01'),
    floorToFloor: f2f,
    ceilingHeight: f2f - 0.3,
    wwr: o.wwr ?? 0.35,
    balcony: o.balcony ?? null,
    region: o.region ?? 'UK',
    options: OPTIONS,
    rng: createRng(3),
    wetWallSide: o.access,
    stackAlong: 1.6,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Rooms reachable from the unit entry by walking through doors (ARC-19) */
function reachableFromEntry(layout: UnitLayout): Set<string> {
  const entry = layout.doors.find(d => d.id === layout.entryDoorId);
  const seen = new Set<string>();
  const start = entry?.toRoomId ?? entry?.fromRoomId;
  if (!start) return seen;
  const queue = [start];
  seen.add(start);
  while (queue.length > 0) {
    const cur = queue.pop() as string;
    for (const d of layout.doors) {
      for (const [a, b] of [[d.fromRoomId, d.toRoomId], [d.toRoomId, d.fromRoomId]]) {
        if (a !== cur || !b || seen.has(b)) continue;
        seen.add(b);
        queue.push(b);
      }
    }
  }
  return seen;
}

/** Glazed area on one side of the unit, and that side's wall area */
function glazingOnSide(layout: UnitLayout, req: UnitLayoutRequest, side: Side): { glazed: number; wall: number } {
  const wall = req.boundaryWalls[side]!;
  const len = req.rect.w === 0 ? 0 : side === 'front' || side === 'rear' ? req.rect.w : req.rect.h;
  const glazed = layout.windows.filter(w => w.wallId === wall.id).reduce((s, w) => s + w.width * w.height, 0)
    + layout.doors.filter(d => d.wallId === wall.id && d.type === 'balcony').reduce((s, d) => s + d.width * d.height * 0.8, 0);
  return { glazed, wall: len * req.floorToFloor };
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

function numbersOf(v: unknown, out: number[] = []): number[] {
  if (typeof v === 'number') out.push(v);
  else if (Array.isArray(v)) for (const x of v) numbersOf(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) numbersOf(x, out);
  return out;
}

function openingsByWall(layout: UnitLayout): Map<string, { id: string; a: number; b: number }[]> {
  const m = new Map<string, { id: string; a: number; b: number }[]>();
  const add = (o: DoorDef | WindowDef): void => {
    const list = m.get(o.wallId) ?? [];
    list.push({ id: o.id, a: o.along - o.width / 2, b: o.along + o.width / 2 });
    m.set(o.wallId, list);
  };
  layout.doors.forEach(add);
  layout.windows.forEach(add);
  return m;
}

function wallLength(w: WallDef): number {
  return Math.hypot(w.end[0] - w.start[0], w.end[1] - w.start[1]);
}

// ---------------------------------------------------------------------------
// Catalogue-level tests
// ---------------------------------------------------------------------------

test('all 20 unit templates are defined and self-consistent', () => {
  assert.equal(UNIT_TEMPLATE_IDS.length, 20);
  for (const id of UNIT_TEMPLATE_IDS) {
    const t = UNIT_TEMPLATES[id];
    assert.ok(t, `template ${id} missing`);
    assert.equal(t.id, id);
    assert.ok(t.name.length > 0);
    assert.ok(t.description.length > 20, `${id}: needs a description`);
    assert.ok(t.area.min <= t.area.target && t.area.target <= t.area.max, `${id}: area range`);
    assert.ok(t.frontage.min < t.frontage.max && t.depth.min < t.depth.max, `${id}: rect ranges`);
    assert.ok(t.rooms.length >= 3, `${id}: needs a room program`);
    assert.ok(t.suitableTypologies.length > 0, `${id}: needs suitableTypologies`);
    assert.ok(t.patterns.length > 0, `${id}: needs patterns`);
    for (const r of t.rooms) {
      assert.ok(r.count >= 1 && r.targetArea >= r.minArea && r.minWidth > 0, `${id}/${r.type}: bad program`);
    }
    // programmed area should be in the same ballpark as the headline area
    const pa = programArea(t);
    assert.ok(pa > t.area.min * 0.7 && pa < t.area.max * 1.25, `${id}: program area ${pa} vs ${t.area.target}`);
    // bedroom count matches the program
    const beds = t.rooms.filter(r => r.type === 'bedroom' || r.type === 'master-bedroom').reduce((s, r) => s + r.count, 0);
    assert.equal(beds, t.bedrooms, `${id}: bedroom count`);
    // regional names for the six English-speaking regions
    for (const reg of ['US', 'UK', 'CA', 'AU', 'NZ', 'IE'] as Region[]) {
      assert.ok(t.regionalNames[reg], `${id}: missing ${reg} name`);
    }
    // the recommended rect must sit inside the declared ranges
    const rec = recommendedRect(id);
    assert.ok(rec.frontage >= t.frontage.min - 1e-9 && rec.frontage <= t.frontage.max + 1e-9, `${id}: recommended frontage`);
    assert.ok(rec.depth >= t.depth.min - 1e-9 && rec.depth <= t.depth.max + 1e-9, `${id}: recommended depth`);
  }
});

test('furniture catalogue covers every FurnitureType with real dimensions', () => {
  const types = Object.keys(FURNITURE_CATALOG);
  assert.ok(types.length >= 45, `catalogue has ${types.length} entries`);
  for (const [k, v] of Object.entries(FURNITURE_CATALOG)) {
    assert.ok(v.w > 0 && v.d > 0 && v.h > 0, `${k}: bad dimensions`);
    assert.ok(v.w < 5 && v.d < 5 && v.h < 2.5, `${k}: implausible dimensions`);
  }
  for (const k of ['wc', 'lavatory', 'vanity', 'shower', 'bathtub', 'kitchen-sink', 'dishwasher', 'washer', 'water-heater'] as const) {
    assert.equal(FURNITURE_CATALOG[k].needsWater, true, `${k} must need water`);
  }
  for (const k of ['fridge', 'range', 'dishwasher', 'washer', 'dryer', 'water-heater', 'tv-unit', 'desk', 'treadmill'] as const) {
    assert.equal(FURNITURE_CATALOG[k].needsPower, true, `${k} must need power`);
  }
});

test('unit pattern book covers ARC-14 … ARC-30', () => {
  const ids = UNIT_PATTERNS.map(p => p.id);
  for (let n = 14; n <= 30; n++) {
    const id = `ARC-${n}`;
    assert.ok(ids.includes(id), `${id} missing`);
  }
  assert.equal(new Set(ids).size, ids.length, 'duplicate pattern ids');
  for (const p of UNIT_PATTERNS) {
    assert.equal(p.discipline, 'architecture');
    assert.ok(p.problem.length > 60, `${p.id}: problem too short`);
    assert.ok(p.solution.length > 60, `${p.id}: solution too short`);
    assert.ok(Object.keys(p.parameters).length >= 3, `${p.id}: needs parameters`);
    assert.ok((p.references ?? []).length >= 1, `${p.id}: needs references`);
    for (const [k, v] of Object.entries(p.parameters)) {
      assert.ok(v.value !== undefined && v.value !== null, `${p.id}.${k}: no value`);
    }
  }
});

// ---------------------------------------------------------------------------
// The layout suite, run against BOTH engines
// ---------------------------------------------------------------------------

/**
 * Every invariant below is a property of the `layoutUnit` CONTRACT, not of one implementation, so the
 * suite is parametrised over the engine. It was the switch criterion for flipping
 * `DEFAULT_DEPS.layoutUnit`: the v2 program solver had to satisfy everything the v1 template engine did
 * before it became the default, and only then was the v1 planner deleted.
 */
function layoutSuite(label: string, layoutUnit: UnitLayoutFn): void {
  const t_ = (name: string, fn: () => void): void => { test(`[${label}] ${name}`, fn); };

  // ---------------------------------------------------------------------------
  // Per-template layout invariants
  // ---------------------------------------------------------------------------

  for (const id of UNIT_TEMPLATE_IDS) {
    t_(`layout ${id}`, () => {
      const t = UNIT_TEMPLATES[id];
      const ids = new Set<string>();
      const stairRects: Rect[] = [];

      for (let level = 0; level < t.storeysInUnit; level++) {
        const req = makeRequest(t, level);
        const layout = layoutUnit(req);
        const label = `${id} L${level}`;
        const unit = req.rect;
        const inside = layout.rooms.filter(r => r.type !== 'balcony');
        assert.ok(inside.length >= 2, `${label}: only ${inside.length} rooms`);

        // --- no NaN anywhere ---------------------------------------------------
        for (const n of numbersOf({ r: layout.rooms, w: layout.walls, d: layout.doors, wi: layout.windows, f: layout.furniture, s: layout.stair })) {
          assert.ok(Number.isFinite(n), `${label}: non-finite number in output`);
        }

        // --- ids unique across the whole unit ---------------------------------
        for (const o of [...layout.rooms, ...layout.walls, ...layout.doors, ...layout.windows, ...layout.furniture]) {
          assert.ok(!ids.has(o.id), `${label}: duplicate id ${o.id}`);
          ids.add(o.id);
        }

        // --- rooms tile the rect ----------------------------------------------
        const area = inside.reduce((s, r) => s + r.area, 0);
        const cover = area / (unit.w * unit.h);
        assert.ok(cover >= 0.92, `${label}: rooms cover only ${(cover * 100).toFixed(1)}% of the net rect`);
        assert.ok(cover <= 1.02, `${label}: rooms cover ${(cover * 100).toFixed(1)}% — overlapping?`);
        for (let i = 0; i < inside.length; i++) {
          for (let j = i + 1; j < inside.length; j++) {
            assert.ok(!rectsOverlap(inside[i].rect, inside[j].rect, 1e-4), `${label}: ${inside[i].name} overlaps ${inside[j].name}`);
          }
          assert.ok(rectContainsRect(unit, inside[i].rect, 1e-3), `${label}: ${inside[i].name} is outside the unit rect`);
          assert.ok(inside[i].area > 0.2, `${label}: ${inside[i].name} is degenerate`);
          assert.equal(inside[i].polygon.length, 4, `${label}: ${inside[i].name} polygon`);
          assert.equal(inside[i].height, req.ceilingHeight);
          assert.equal(inside[i].storey, req.storey);
          assert.equal(inside[i].unitId, req.unitId);
        }

        // --- balcony lives outside the rect -----------------------------------
        const balcony = layout.rooms.find(r => r.type === 'balcony');
        if (req.balcony) {
          assert.ok(balcony, `${label}: balcony requested but not created`);
          assert.equal(layout.balconyRoomId, balcony?.id);
          assert.ok(!rectsOverlap(unit, balcony!.rect, 1e-4), `${label}: balcony overlaps the unit`);
          assert.ok(layout.doors.some(d => d.type === 'balcony'), `${label}: no balcony door`);
        } else {
          assert.equal(balcony, undefined, `${label}: unexpected balcony`);
        }

        // --- daylight ----------------------------------------------------------
        const progOf = (r: RoomDef): boolean => {
          const p = t.rooms.find(x => x.type === r.type);
          return p ? p.needsExterior : false;
        };
        for (const r of inside) {
          if (!progOf(r)) continue;
          assert.ok(r.windowIds.length >= 1, `${label}: ${r.name} needs daylight but has no window`);
          assert.ok(r.hasExterior && r.exteriorWallIds.length >= 1, `${label}: ${r.name} has no exterior wall recorded`);
        }

        // --- doors -------------------------------------------------------------
        for (const r of layout.rooms) {
          assert.ok(r.doorIds.length >= 1, `${label}: ${r.name} has no door`);
        }
        for (const d of layout.doors) {
          assert.ok(d.width >= 0.6 && d.width <= 2.8, `${label}: door ${d.id} width ${d.width}`);
          assert.equal(d.height, d.type === 'garage' ? d.height : SIZES.doorHeight);
          assert.ok(d.along > 0, `${label}: door ${d.id} along ${d.along}`);
          const host = layout.walls.find(w => w.id === d.wallId)
            ?? Object.values(req.boundaryWalls).find(w => w && w.id === d.wallId);
          assert.ok(host, `${label}: door ${d.id} has no host wall`);
          const len = wallLength(host as WallDef);
          assert.ok(d.along - d.width / 2 >= -1e-6 && d.along + d.width / 2 <= len + 1e-6,
            `${label}: door ${d.id} (${d.along}±${d.width / 2}) falls outside its ${len.toFixed(2)} m wall`);
        }

        // --- unit entry door ---------------------------------------------------
        if (level === 0) {
          assert.ok(layout.entryDoorId.length > 0, `${label}: no entry door`);
          const entry = layout.doors.find(d => d.id === layout.entryDoorId);
          assert.ok(entry, `${label}: entry door not in doors[]`);
          const accessWall = req.boundaryWalls[req.accessSide]!;
          assert.equal(entry!.wallId, accessWall.id, `${label}: entry door not hosted in the access wall`);
          assert.equal(entry!.type, 'unit-entry');
          assert.equal(entry!.fireRated, true);
          assert.equal(entry!.width, SIZES.doorUnitEntry);
          const len = wallLength(accessWall);
          assert.ok(entry!.along - entry!.width / 2 >= 0 && entry!.along + entry!.width / 2 <= len,
            `${label}: entry door outside the access wall length`);
        }

        // --- openings never overlap on a wall ----------------------------------
        for (const [wallId, list] of openingsByWall(layout)) {
          const sorted = [...list].sort((p, q) => p.a - q.a);
          for (let i = 1; i < sorted.length; i++) {
            assert.ok(sorted[i].a >= sorted[i - 1].b - 1e-6,
              `${label}: openings ${sorted[i - 1].id} and ${sorted[i].id} overlap on wall ${wallId}`);
          }
        }

        // --- windows -----------------------------------------------------------
        for (const w of layout.windows) {
          // ARC-16 limits: at least a 0.9 m sash, never wider than the room's own wall span less
          // 0.6 m, head below the ceiling and below the slab soffit
          assert.ok(w.width >= 0.9 - 1e-6, `${label}: window ${w.id} width ${w.width}`);
          assert.ok(w.sill >= 0.3 && w.sill + w.height <= req.ceilingHeight + 1e-6, `${label}: window ${w.id} sill/head`);
          assert.ok(w.sill + w.height <= req.floorToFloor - 0.3 + 1e-6, `${label}: window ${w.id} head above the soffit`);
          assert.ok(layout.rooms.some(r => r.id === w.roomId), `${label}: window ${w.id} roomId dangling`);
          const host = Object.values(req.boundaryWalls).find(x => x && x.id === w.wallId);
          assert.ok(host, `${label}: window ${w.id} not hosted in a boundary wall`);
          assert.ok(host!.type === 'exterior', `${label}: window ${w.id} in a ${host!.type} wall`);
          const room = layout.rooms.find(r => r.id === w.roomId)!;
          const horizontal = Math.abs(host!.end[1] - host!.start[1]) < 1e-6;
          const roomSpan = horizontal ? room.rect.w : room.rect.h;
          assert.ok(w.width <= Math.max(0.9, roomSpan - 0.6) + 1e-6,
            `${label}: window ${w.id} is ${w.width} m in a ${roomSpan.toFixed(2)} m wall span of ${room.name}`);
        }
        // per exterior wall, the windows of one room never exceed its span
        const byWallRoom = new Map<string, number>();
        for (const w of layout.windows) {
          const k = `${w.wallId}|${w.roomId}`;
          byWallRoom.set(k, (byWallRoom.get(k) ?? 0) + w.width);
        }
        for (const [k, total] of byWallRoom) {
          const [wallId, rid] = k.split('|');
          const host = Object.values(req.boundaryWalls).find(x => x && x.id === wallId)!;
          const room = layout.rooms.find(r => r.id === rid)!;
          const horizontal = Math.abs(host.end[1] - host.start[1]) < 1e-6;
          const roomSpan = horizontal ? room.rect.w : room.rect.h;
          assert.ok(total <= Math.max(0.9, roomSpan) + 1e-6, `${label}: ${room.name} glazes ${total.toFixed(2)} m of a ${roomSpan.toFixed(2)} m wall`);
        }

        // --- walls -------------------------------------------------------------
        const wallKey = new Set<string>();
        for (const w of layout.walls) {
          assert.ok(wallLength(w) > 0.5, `${label}: wall ${w.id} is ${wallLength(w).toFixed(2)} m long`);
          assert.equal(w.height, req.floorToFloor - SIZES.slabT);
          assert.equal(w.isExternal, false);
          assert.ok(w.leftRoomId && w.rightRoomId, `${label}: wall ${w.id} has no left/right rooms`);
          assert.notEqual(w.leftRoomId, w.rightRoomId);
          assert.ok(w.thickness === SIZES.partitionT || w.thickness === SIZES.wetWallT, `${label}: wall ${w.id} thickness`);
          const key = [w.leftRoomId, w.rightRoomId].sort().join('|');
          assert.ok(!wallKey.has(key), `${label}: duplicate wall between ${key}`);
          wallKey.add(key);
        }

        // --- wet wall ----------------------------------------------------------
        assert.ok(layout.wetWallIds.length > 0, `${label}: no wet wall`);
        const wetRooms = new Set<string>();
        for (const id2 of layout.wetWallIds) {
          const w = layout.walls.find(x => x.id === id2);
          assert.ok(w, `${label}: wetWallId ${id2} not in walls`);
          assert.equal(w!.type, 'wet');
          assert.equal(w!.thickness, SIZES.wetWallT);
          if (w!.leftRoomId) wetRooms.add(w!.leftRoomId);
          if (w!.rightRoomId) wetRooms.add(w!.rightRoomId);
        }
        const hasKitchenOnLevel = layout.rooms.some(r => r.id === layout.kitchenRoomId);
        if (hasKitchenOnLevel) {
          assert.ok(wetRooms.has(layout.kitchenRoomId!), `${label}: no wet wall bounds the kitchen`);
        }
        if (layout.bathroomRoomIds.length > 0) {
          assert.ok(layout.bathroomRoomIds.some(b => wetRooms.has(b)), `${label}: no wet wall bounds a bathroom`);
        }

        // --- furniture ---------------------------------------------------------
        const byRoom = new Map<string, FurnitureDef[]>();
        for (const f of layout.furniture) {
          assert.ok(FURNITURE_CATALOG[f.type], `${label}: unknown furniture type ${f.type}`);
          assert.ok(f.width > 0 && f.depth > 0 && f.height > 0, `${label}: furniture ${f.id} size`);
          const spec = FURNITURE_CATALOG[f.type];
          assert.equal(f.needsWater, spec.needsWater);
          assert.equal(f.needsPower, spec.needsPower);
          const q = f.rotation / (Math.PI / 2);
          assert.ok(Math.abs(q - Math.round(q)) < 1e-6, `${label}: furniture ${f.id} rotation ${f.rotation} is not a right angle`);
          const room = layout.rooms.find(r => r.id === f.roomId);
          assert.ok(room, `${label}: furniture ${f.id} has no room`);
          assert.ok(rectContainsRect(room!.rect, furnitureAabb(f), 5e-3),
            `${label}: ${f.type} sticks out of ${room!.name}`);
          const list = byRoom.get(f.roomId) ?? [];
          list.push(f);
          byRoom.set(f.roomId, list);
        }
        for (const [roomId, list] of byRoom) {
          for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
              assert.ok(!rectsOverlap(furnitureAabb(list[i]), furnitureAabb(list[j]), 1e-3),
                `${label}: ${list[i].type} overlaps ${list[j].type} in ${roomId}`);
            }
          }
        }
        // a dwelling level with a bedroom must have a bed in it
        for (const r of inside) {
          if (r.type !== 'bedroom' && r.type !== 'master-bedroom') continue;
          const items = byRoom.get(r.id) ?? [];
          assert.ok(items.some(f => f.type.startsWith('bed-')), `${label}: ${r.name} has no bed`);
        }

        // --- stair -------------------------------------------------------------
        if (t.storeysInUnit > 1) {
          assert.ok(layout.stair, `${label}: multi-level unit without a stair`);
          const st = layout.stair!;
          assert.ok(st.risers >= 12 && st.risers <= 24, `${label}: ${st.risers} risers`);
          assert.ok(st.riserHeight <= SIZES.stairRiserMax + 1e-9, `${label}: riser ${st.riserHeight}`);
          assert.ok(st.tread >= SIZES.stairTreadMin - 0.03, `${label}: tread ${st.tread}`);
          assert.ok(st.width >= 0.85, `${label}: stair width ${st.width}`);
          assert.ok(rectContainsRect(unit, st.rect, 1e-3), `${label}: stair outside the unit`);
          assert.ok(layout.rooms.some(r => r.type === 'stair'), `${label}: no stair room`);
          stairRects.push(st.rect);
        } else {
          assert.equal(layout.stair, undefined, `${label}: single-level unit returned a stair`);
        }

        // --- patterns ----------------------------------------------------------
        assert.ok(layout.patterns.length >= 4, `${label}: only ${layout.patterns.length} pattern applications`);
        const known = new Set([...UNIT_PATTERNS.map(p => p.id), 'XD-01', 'XD-05']);
        for (const a of layout.patterns) {
          assert.ok(known.has(a.patternId), `${label}: unknown pattern ${a.patternId}`);
          assert.equal(a.unitId, req.unitId);
          assert.ok(a.params && Object.keys(a.params).length > 0, `${label}: ${a.patternId} has no params`);
        }
        assert.ok(layout.patterns.some(p => p.patternId === 'ARC-14'), `${label}: ARC-14 not applied`);
      }

      // stacked stair: identical footprint on every level (ARC-22)
      if (t.storeysInUnit > 1) {
        assert.equal(stairRects.length, t.storeysInUnit);
        for (const r of stairRects) {
          assert.ok(Math.abs(r.x - stairRects[0].x) < 1e-6 && Math.abs(r.y - stairRects[0].y) < 1e-6
            && Math.abs(r.w - stairRects[0].w) < 1e-6 && Math.abs(r.h - stairRects[0].h) < 1e-6,
            `${id}: stair rects differ between levels`);
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Behaviour of specific templates
  // ---------------------------------------------------------------------------

  t_('senior-1b-accessible uses 0.9 m doors, a 1.5 m turning circle and a roll-in shower', () => {
    const t = UNIT_TEMPLATES['senior-1b-accessible'];
    const layout = layoutUnit(makeRequest(t, 0));
    for (const d of layout.doors) {
      if (d.type === 'closet' || d.type === 'service' || d.motion === 'opening' || d.type === 'balcony') continue;
      assert.ok(d.width >= 0.9 - 1e-9, `door ${d.id} is ${d.width} m wide`);
    }
    const bath = layout.rooms.find(r => layout.bathroomRoomIds.includes(r.id))!;
    assert.ok(Math.min(bath.rect.w, bath.rect.h) >= 2.1, `bathroom clear width ${Math.min(bath.rect.w, bath.rect.h)}`);
    const shower = layout.furniture.find(f => f.type === 'shower');
    assert.ok(shower && Math.max(shower.width, shower.depth) >= 1.4, 'no roll-in shower');
    assert.ok(layout.furniture.some(f => f.type === 'grab-rail'), 'no grab rails');
    assert.ok(layout.patterns.some(p => p.patternId === 'ARC-23'), 'ARC-23 not applied');
  });

  t_('coliving-cluster puts six en-suite bedrooms off a corridor with a shared hearth', () => {
    const t = UNIT_TEMPLATES['coliving-cluster'];
    const layout = layoutUnit(makeRequest(t, 0));
    assert.equal(layout.rooms.filter(r => r.type === 'bedroom').length, 6);
    assert.equal(layout.rooms.filter(r => r.type === 'ensuite').length, 6);
    assert.ok(layout.rooms.some(r => r.type === 'corridor'), 'no internal corridor');
    assert.ok(layout.rooms.some(r => r.type === 'shared-living'), 'no shared living');
    for (const bed of layout.rooms.filter(r => r.type === 'bedroom')) {
      assert.ok(bed.windowIds.length >= 1, `${bed.name} has no window`);
      assert.equal(bed.occupancy, 1);
    }
    assert.ok(layout.patterns.some(p => p.patternId === 'ARC-24'), 'ARC-24 not applied');
  });

  t_('dual-key gives the studio its own bath, kitchenette and door off the vestibule', () => {
    const t = UNIT_TEMPLATES['dual-key'];
    const layout = layoutUnit(makeRequest(t, 0));
    const vest = layout.rooms.find(r => r.type === 'entry')!;
    assert.ok(vest, 'no vestibule');
    const studio = layout.rooms.find(r => r.type === 'living-kitchen');
    assert.ok(studio, 'no studio living/kitchen');
    assert.ok(layout.bathroomRoomIds.length >= 2, 'studio needs its own bathroom');
    // two lockable doors off the vestibule (main flat + studio)
    const offVest = layout.doors.filter(d => d.fromRoomId === vest.id || d.toRoomId === vest.id);
    assert.ok(offVest.length >= 3, `only ${offVest.length} doors at the vestibule`);
    assert.ok(layout.patterns.some(p => p.patternId === 'ARC-25'), 'ARC-25 not applied');
  });

  t_('corner-2b2b gives the living room light on two sides (ARC-26)', () => {
    const t = UNIT_TEMPLATES['corner-2b2b'];
    const layout = layoutUnit(makeRequest(t, 0));
    const living = layout.rooms.find(r => r.type === 'living')!;
    assert.ok(living.exteriorWallIds.length >= 2, `living room has ${living.exteriorWallIds.length} exterior walls`);
    const app = layout.patterns.find(p => p.patternId === 'ARC-26');
    assert.ok(app, 'ARC-26 not applied');
    assert.equal(app!.params!.lightOnTwoSides, true);
  });

  t_('townhouse-3s puts the garage at ground, living on the first floor and bedrooms above', () => {
    const t = UNIT_TEMPLATES['townhouse-3s'];
    const types = [0, 1, 2].map(l => new Set(layoutUnit(makeRequest(t, l)).rooms.map(r => r.type)));
    assert.ok(types[0].has('garage'), 'no garage at ground level');
    assert.ok(types[1].has('living') && types[1].has('kitchen'), 'no living/kitchen on level 1');
    assert.ok(types[2].has('master-bedroom') && types[2].has('bathroom'), 'no bedrooms on level 2');
    for (const s of types) assert.ok(s.has('stair'), 'stair missing on a level');
  });

  t_('regional vocabulary follows the requested region', () => {
    const t = UNIT_TEMPLATES['2b2b'];
    const us = layoutUnit(makeRequest(t, 0, 'US'));
    const uk = layoutUnit(makeRequest(t, 0, 'UK'));
    assert.ok(us.rooms.some(r => r.name === 'Primary Bedroom'), 'US naming');
    assert.ok(uk.rooms.some(r => r.name === 'Principal Bedroom'), 'UK naming');
    assert.ok(uk.rooms.some(r => r.name.startsWith('Utility') || r.name.startsWith('Store')), 'UK service room naming');
  });

  t_('layout is deterministic for the same request', () => {
    const t = UNIT_TEMPLATES['3b2b'];
    const a = layoutUnit(makeRequest(t, 0));
    const b = layoutUnit(makeRequest(t, 0));
    assert.deepEqual(a.rooms.map(r => [r.id, r.rect]), b.rooms.map(r => [r.id, r.rect]));
    assert.deepEqual(a.furniture.map(f => [f.id, f.position, f.rotation]), b.furniture.map(f => [f.id, f.position, f.rotation]));
  });

  t_('degrades gracefully in a rect that is far too small', () => {
    const t = UNIT_TEMPLATES['3b2b'];
    const req = makeRequest(t, 0);
    const small: UnitLayoutRequest = { ...req, rect: { x: 12, y: 7, w: 7.0, h: 7.0 }, balcony: null };
    small.boundaryWalls = boundaryWalls(small.rect, 'front', ['rear'], small.storey);
    const layout = layoutUnit(small);
    assert.ok(layout.warnings.length > 0, 'a 49 m² 3-bed should warn');
    assert.ok(layout.rooms.length >= 4, 'still produces rooms');
    const cover = layout.rooms.reduce((s, r) => s + r.area, 0) / (7 * 7);
    assert.ok(cover >= 0.92, `coverage ${(cover * 100).toFixed(1)}%`);
    for (const n of numbersOf(layout.rooms)) assert.ok(Number.isFinite(n));
  });

  t_('every access side and a rotated rect produce the same plan quality', () => {
    const t = UNIT_TEMPLATES['2b2b'];
    for (const access of ['front', 'rear', 'left', 'right'] as Side[]) {
      const base = makeRequest(t, 0);
      const rect: Rect = access === 'front' || access === 'rear'
        ? base.rect
        : { x: base.rect.x, y: base.rect.y, w: base.rect.h, h: base.rect.w };
      const ext: Side[] = [access === 'front' ? 'rear' : access === 'rear' ? 'front' : access === 'left' ? 'right' : 'left'];
      const req: UnitLayoutRequest = {
        ...base, rect, accessSide: access, exteriorSides: ext,
        boundaryWalls: boundaryWalls(rect, access, ext, base.storey),
        balcony: { side: ext[0], depth: 1.8 },
      };
      const layout = layoutUnit(req);
      const inside = layout.rooms.filter(r => r.type !== 'balcony');
      const cover = inside.reduce((s, r) => s + r.area, 0) / (rect.w * rect.h);
      assert.ok(cover >= 0.92, `${access}: coverage ${(cover * 100).toFixed(1)}%`);
      for (const r of inside) assert.ok(rectContainsRect(rect, r.rect, 1e-3), `${access}: ${r.name} outside the rect`);
      assert.ok(layout.entryDoorId.length > 0, `${access}: no entry door`);
      const entry = layout.doors.find(d => d.id === layout.entryDoorId)!;
      assert.equal(entry.wallId, req.boundaryWalls[access]!.id);
      for (const r of inside) assert.ok(r.doorIds.length >= 1, `${access}: ${r.name} has no door`);
      assert.ok(layout.wetWallIds.length > 0, `${access}: no wet wall`);
    }
  });

  // ---------------------------------------------------------------------------
  // ARC-36 — the through flat (side entry, daylight on two end façades)
  // ---------------------------------------------------------------------------

  /** Every invariant a through unit has to satisfy, whatever its exposures are. */
  function assertThroughUnit(layout: UnitLayout, req: UnitLayoutRequest, label: string): void {
    const t = req.template;
    const inside = layout.rooms.filter(r => r.type !== 'balcony');

    // rooms tile the rect
    const cover = inside.reduce((s, r) => s + r.area, 0) / (req.rect.w * req.rect.h);
    assert.ok(cover >= 0.92, `${label}: rooms cover only ${(cover * 100).toFixed(1)}% of the rect`);
    assert.ok(cover <= 1.02, `${label}: rooms cover ${(cover * 100).toFixed(1)}% — overlapping?`);
    for (let i = 0; i < inside.length; i++) {
      assert.ok(rectContainsRect(req.rect, inside[i].rect, 1e-3), `${label}: ${inside[i].name} outside the rect`);
      for (let j = i + 1; j < inside.length; j++) {
        assert.ok(!rectsOverlap(inside[i].rect, inside[j].rect, 1e-4), `${label}: ${inside[i].name} overlaps ${inside[j].name}`);
      }
    }

    // every room that wants daylight has one, and it comes from an exterior boundary wall
    const extWallIds = new Set(req.exteriorSides.map(s => req.boundaryWalls[s]!.id));
    for (const r of inside) {
      const prog = t.rooms.find(x => x.type === r.type);
      if (!prog?.needsExterior) continue;
      assert.ok(r.windowIds.length >= 1, `${label}: ${r.name} needs daylight but has no window`);
      assert.ok(r.exteriorWallIds.some(id => extWallIds.has(id)), `${label}: ${r.name} has no exterior wall`);
    }

    // both façades are used
    for (const s of req.exteriorSides) {
      const id = req.boundaryWalls[s]!.id;
      assert.ok(layout.windows.some(w => w.wallId === id), `${label}: the ${s} façade carries no window`);
    }

    // the entry hall reaches every room
    assert.ok(layout.entryDoorId.length > 0, `${label}: no entry door`);
    const reach = reachableFromEntry(layout);
    for (const r of inside) {
      assert.ok(r.doorIds.length >= 1, `${label}: ${r.name} has no door`);
      assert.ok(reach.has(r.id), `${label}: ${r.name} cannot be reached from the entry`);
    }

    // the hall/entry strip stands on the access wall and the wet rooms share a wet wall
    const onAccess = inside.filter(r => (r.type === 'hall' || r.type === 'entry')
      && (req.accessSide === 'front' ? Math.abs(r.rect.y - req.rect.y) < 1e-3 : true));
    assert.ok(onAccess.length >= 1, `${label}: no hall along the access wall`);
    assert.ok(layout.wetWallIds.length > 0, `${label}: no wet wall`);
    const wetRooms = new Set<string>();
    for (const id of layout.wetWallIds) {
      const w = layout.walls.find(x => x.id === id)!;
      assert.equal(w.type, 'wet', `${label}: ${id} is not a wet wall`);
      if (w.leftRoomId) wetRooms.add(w.leftRoomId);
      if (w.rightRoomId) wetRooms.add(w.rightRoomId);
    }
    if (layout.kitchenRoomId) assert.ok(wetRooms.has(layout.kitchenRoomId), `${label}: no wet wall bounds the kitchen`);
    assert.ok(layout.bathroomRoomIds.some(b => wetRooms.has(b)), `${label}: no wet wall bounds a bathroom`);

    // ARC-36 recorded
    const app = layout.patterns.find(p => p.patternId === 'ARC-36');
    assert.ok(app, `${label}: ARC-36 not applied`);
    assert.equal(app!.params!.facadeCount, req.exteriorSides.length, `${label}: ARC-36 façade count`);
    assert.equal(app!.params!.habitableRoomsLit, app!.params!.habitableRooms, `${label}: a habitable room is unlit`);
  }

  t_('ARC-36 through flat: 2b2b entered from the landing, living room on the sunny façade', () => {
    const req = makeSideEntryRequest({
      templateId: '2b2b', rect: { x: 10, y: 4, w: 8, h: 15.4 }, access: 'right',
      ext: ['front', 'rear'], exposures: { front: 'S', rear: 'N' }, region: 'UK',
    });
    const layout = layoutUnit(req);
    assertThroughUnit(layout, req, '2b2b through S/N');
    // the living room takes the south façade (front) and the bedrooms the north one
    const living = layout.rooms.find(r => r.type === 'living')!;
    assert.ok(living, 'no living room');
    assert.ok(Math.abs(living.rect.y - req.rect.y) < 1e-3, `living room is at y=${living.rect.y}, not on the front wall`);
    assert.ok(living.exteriorWallIds.includes(req.boundaryWalls.front!.id), 'living room does not touch the front wall');
    const master = layout.rooms.find(r => r.type === 'master-bedroom')!;
    assert.ok(Math.abs(master.rect.y + master.rect.h - (req.rect.y + req.rect.h)) < 1e-3,
      'principal bedroom is not on the rear (north) façade');
    assert.equal(layout.patterns.find(p => p.patternId === 'ARC-36')!.params!.livingExposure, 'front:S');
    // the principal bedroom is the room farthest from the entry door (ARC-19 / APL #127)
    const entry = layout.doors.find(d => d.id === layout.entryDoorId)!;
    const host = layout.walls.find(w => w.id === entry.wallId) ?? req.boundaryWalls[req.accessSide]!;
    const ex = host.start[0] + ((host.end[0] - host.start[0]) * entry.along) / Math.hypot(host.end[0] - host.start[0], host.end[1] - host.start[1]);
    const ey = host.start[1] + ((host.end[1] - host.start[1]) * entry.along) / Math.hypot(host.end[0] - host.start[0], host.end[1] - host.start[1]);
    const distOf = (r: RoomDef): number => Math.hypot(r.rect.x + r.rect.w / 2 - ex, r.rect.y + r.rect.h / 2 - ey);
    const beds = layout.rooms.filter(r => r.type === 'bedroom' || r.type === 'master-bedroom');
    assert.equal(beds.sort((a, b) => distOf(b) - distOf(a))[0].type, 'master-bedroom', 'the principal bedroom is not the farthest');
  });

  t_('ARC-36 through flat: flipping the exposures moves the living room to the other façade', () => {
    const req = makeSideEntryRequest({
      templateId: '2b2b', rect: { x: 10, y: 4, w: 8, h: 15.4 }, access: 'right',
      ext: ['front', 'rear'], exposures: { front: 'N', rear: 'S' }, region: 'UK',
    });
    const layout = layoutUnit(req);
    assertThroughUnit(layout, req, '2b2b through N/S');
    const living = layout.rooms.find(r => r.type === 'living')!;
    assert.ok(Math.abs(living.rect.y + living.rect.h - (req.rect.y + req.rect.h)) < 1e-3,
      `living room is at y=${living.rect.y}, not on the rear wall`);
    assert.ok(living.exteriorWallIds.includes(req.boundaryWalls.rear!.id), 'living room does not touch the rear wall');
    assert.equal(layout.patterns.find(p => p.patternId === 'ARC-36')!.params!.livingExposure, 'rear:S');
    // southern hemisphere: the same compass exposures send the living room the other way
    const au = layoutUnit(makeSideEntryRequest({
      templateId: '2b2b', rect: { x: 10, y: 4, w: 8, h: 15.4 }, access: 'right',
      ext: ['front', 'rear'], exposures: { front: 'N', rear: 'S' }, region: 'AU',
    }));
    const auLiving = au.rooms.find(r => r.type === 'living')!;
    assert.ok(Math.abs(auLiving.rect.y - 4) < 1e-3, 'in AU the north façade should take the living room');
  });

  t_('ARC-36 through flat: an end-of-bar unit with three exterior sides keeps every room lit', () => {
    const req = makeSideEntryRequest({
      templateId: '2b1b', rect: { x: 10, y: 4, w: 4.4, h: 15.4 }, access: 'left',
      ext: ['front', 'rear', 'right'], exposures: { front: 'S', rear: 'N', right: 'E' }, region: 'UK',
    });
    const layout = layoutUnit(req);
    assertThroughUnit(layout, req, '2b1b end-of-bar');
    // the extra façade is the one opposite the entry: it lets the room that lost an end façade
    // keep a window, so nothing is left dark
    const dark = layout.rooms.filter(r => {
      const prog = req.template.rooms.find(x => x.type === r.type);
      return prog?.needsExterior && r.windowIds.length === 0;
    });
    assert.equal(dark.length, 0, `unlit rooms: ${dark.map(r => r.name).join(', ')}`);
    const living = layout.rooms.find(r => r.type === 'living')!;
    assert.ok(living.exteriorWallIds.length >= 2, `living room has ${living.exteriorWallIds.length} exterior walls`);
  });

  t_('ARC-36 through flat: a frontage too short for every habitable room says so once', () => {
    const req = makeSideEntryRequest({
      templateId: '2b1b', rect: { x: 10, y: 4, w: 4.0, h: 15.4 }, access: 'left',
      ext: ['front', 'rear'], exposures: { front: 'S', rear: 'N' }, region: 'UK',
    });
    const layout = layoutUnit(req);
    // 2 × 4 m of façade cannot light a living room and two bedrooms: one warning, naming the cause
    const lit = layout.rooms.filter(r => r.windowIds.length > 0).length;
    assert.ok(lit >= 2, `only ${lit} rooms are lit`);
    const away = layout.warnings.filter(w => w.includes('placed away from the façade'));
    assert.equal(away.length, 1, `expected one façade warning, got ${layout.warnings.length}: ${layout.warnings.join(' | ')}`);
    assert.equal(layout.warnings.filter(w => w.includes('needs daylight but has no exterior wall')).length, 0,
      'the per-room daylight warning should not repeat what the plan already reported');
    const cover = layout.rooms.reduce((s, r) => s + r.area, 0) / (4.0 * 15.4);
    assert.ok(cover >= 0.92, `coverage ${(cover * 100).toFixed(1)}%`);
  });

  // ---------------------------------------------------------------------------
  // ARC-16 — window-to-wall ratio
  // ---------------------------------------------------------------------------

  t_('ARC-16 glazing hits the window-to-wall target on each exterior wall', () => {
    for (const wwr of [0.35, 0.25, 0.45]) {
      const req = makeSideEntryRequest({
        templateId: '1b1b', rect: { x: 5, y: 5, w: 6.4, h: 9 }, access: 'front',
        ext: ['rear'], exposures: { rear: 'S' }, region: 'UK', wwr,
      });
      const layout = layoutUnit(req);
      const { glazed, wall } = glazingOnSide(layout, req, 'rear');
      const ratio = glazed / wall;
      assert.ok(Math.abs(ratio - wwr) <= 0.05,
        `wwr ${wwr}: achieved ${ratio.toFixed(3)} (${glazed.toFixed(2)} m² of glass on ${wall.toFixed(2)} m² of wall)`);
      // and the engine says so in ARC-16
      const app = layout.patterns.find(p => p.patternId === 'ARC-16')!;
      assert.ok(app, 'ARC-16 not applied');
      assert.equal(app.params!.targetWwr, wwr);
      assert.ok(Math.abs(Number(app.params!.achievedWwr) - wwr) <= 0.05,
        `ARC-16 reports ${app.params!.achievedWwr} against a ${wwr} target`);
      assert.equal(app.params!.meetsTarget, true, `wwr ${wwr}: meetsTarget false`);
      // per-window limits
      for (const w of layout.windows) {
        assert.ok(w.width >= 0.9 - 1e-6, `wwr ${wwr}: sash ${w.width} m is under 0.9 m`);
        assert.ok(w.sill === (wwr > 0.4 ? 0.6 : 0.9) || w.sill === 0.9, `wwr ${wwr}: sill ${w.sill}`);
        assert.ok(w.sill + w.height <= req.floorToFloor - 0.3 + 1e-6, `wwr ${wwr}: head above the soffit`);
      }
    }
  });

  t_('ARC-16 counts a balcony door as glazing and still reaches the target', () => {
    const req = makeSideEntryRequest({
      templateId: '2b2b', rect: { x: 5, y: 5, w: 9.9, h: 8.6 }, access: 'rear',
      ext: ['front'], exposures: { front: 'S' }, region: 'US', wwr: 0.35, floorToFloor: 3.1,
      balcony: { side: 'front', depth: 1.8 },
    });
    const layout = layoutUnit(req);
    assert.ok(layout.doors.some(d => d.type === 'balcony'), 'no balcony door');
    const { glazed, wall } = glazingOnSide(layout, req, 'front');
    assert.ok(glazed / wall >= 0.3, `glazing ${(glazed / wall * 100).toFixed(1)} % of the balcony façade`);
    const app = layout.patterns.find(p => p.patternId === 'ARC-16')!;
    assert.ok(Number(app.params!.glazedAreaWithDoors) > Number(app.params!.glazedArea),
      'the balcony door is not counted toward the glazing');
  });

  t_('ARC-16 reports the shortfall when a garage or a store blocks the façade', () => {
    // the ground floor of a three-storey townhouse is mostly garage: the target cannot be met on
    // that wall, and the engine measures itself against the wall the rooms can actually use
    const t = UNIT_TEMPLATES['townhouse-3s'];
    const layout = layoutUnit(makeRequest(t, 0));
    const app = layout.patterns.find(p => p.patternId === 'ARC-16')!;
    assert.ok(app, 'ARC-16 not applied');
    assert.ok(Number(app.params!.glazableArea) < Number(app.params!.facadeArea) - 1,
      'a garage façade should not count as glazable');
    assert.ok(Number(app.params!.achievedWwrGlazable) > Number(app.params!.achievedWwr),
      'the glazable ratio should be the higher of the two');
  });

  t_('all 20 templates lay out in under 50 ms', () => {
    const run = (): number => {
      let n = 0;
      for (const id of UNIT_TEMPLATE_IDS) {
        const t = UNIT_TEMPLATES[id];
        for (let l = 0; l < t.storeysInUnit; l++) n += layoutUnit(makeRequest(t, l)).rooms.length;
      }
      return n;
    };
    run(); // warm up
    run();
    const t0 = performance.now();
    const rooms = run();
    const ms = performance.now() - t0;
    assert.ok(rooms > 200, `only ${rooms} rooms generated`);
    assert.ok(ms < 50, `layout of all templates took ${ms.toFixed(1)} ms`);
  });

}

/**
 * Only the v2 solver remains: the v1 deform-then-warn planner was deleted once this suite passed
 * against both (design §7 M9). The runner stays parametrised so the next engine has the same bar.
 */
layoutSuite('v2', layoutUnitV2);