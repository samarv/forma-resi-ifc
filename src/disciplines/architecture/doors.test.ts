/**
 * Door convention tests — the regression net under the v1 swing bug.
 *
 * v1 had no hinge and no swing on `DoorDef`: the 2D plan drew every leaf hinged at the low-`along` end of the
 * opening, swinging to the left normal of the host wall's stored direction, so the arc landed in the right room
 * only when the wall happened to be wound the right way (1335 of 1827 swing doors across the ten presets were
 * wrong). v2 derives hinge + swing ONCE in the producer with `solveSwing` and every consumer reads the fields, so
 * the test is a single geometric probe: step 0.3 of the leaf width from the hinge toward the latch, 0.05 m onto the
 * swing side, and land inside the room the door says its leaf sweeps.
 *
 *   node --test src/disciplines/architecture/doors.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type {
  ArchModel, DoorDef, DoorHinge, DoorMotion, DoorSwing, GenContext, Rect, RoomType, Side, UnitTemplateId, WallDef,
} from '../../core/types.ts';
import type { UnitLayoutRequest } from './unit-layout-types.ts';
import { PRESETS, normalizeSpec } from '../../core/spec.ts';
import { getTypology } from '../../core/typologies.ts';
import { createRng } from '../../core/rng.ts';
import {
  doorOperation, drawsArc, hingePoint, latchPoint, latchSide, leafTip, reachRect, swingArc, swingProbe,
  LEAF_MIN, LEAF_MIN_BATH, PROBE_DEPTH,
} from '../../core/openings.ts';
import { recommendedRect, UNIT_TEMPLATES } from './templates.ts';
import { layoutUnitV2 as layoutUnit } from './program/solver.ts';
import { generateArchitecture, resolveArchitectureDeps } from './index.ts';
import { makeFixture, type FixtureKind } from './test-fixtures.ts';

await resolveArchitectureDeps();

const FIXTURE_KINDS: FixtureKind[] = ['bar-double', 'point', 'townhouse', 'walkup', 'gallery'];

/** Doors whose leaf must sweep a room's floor — an exit or a street door swings OUT, into no room at all */
const INSIDE_TYPES = new Set<DoorDef['type']>(['unit-entry', 'interior', 'closet']);

function inRect(r: Rect, p: [number, number]): boolean {
  return p[0] >= r.x - 1e-6 && p[0] <= r.x + r.w + 1e-6 && p[1] >= r.y - 1e-6 && p[1] <= r.y + r.h + 1e-6;
}

interface ProbeReport { checked: number; inside: number; missing: string[]; wrong: string[] }

const BATH_ROOMS = new Set<RoomType>(['bathroom', 'ensuite', 'powder', 'wc']);

/** A cupboard front is not a leaf anybody walks through: it may be as narrow as the cupboard */
const CUPBOARD_MIN = 0.6;

/** The clear leaf a door of this role must reach: a bathroom leaf may drop to 0.75 m (LEAF_MIN_BATH) */
function leafMinFor(d: DoorDef, roomType: Map<string, RoomType>): number {
  if (d.type === 'closet' || (d.type === 'service' && d.motion === 'folding')) return CUPBOARD_MIN;
  if (d.type !== 'interior') return LEAF_MIN[d.type];
  const from = d.fromRoomId ? roomType.get(d.fromRoomId) : undefined;
  const to = d.toRoomId ? roomType.get(d.toRoomId) : undefined;
  if ((from && BATH_ROOMS.has(from)) || (to && BATH_ROOMS.has(to))) return LEAF_MIN_BATH;
  return LEAF_MIN.interior;
}

/**
 * Probe every swing door of an arch model. `reachRect` extends the target room to half a probe depth past the host
 * wall's centreline, because a boundary wall's centreline sits outside the net room rect by half its thickness —
 * the probe answers "which side of the wall", and that is the room's side of it.
 */
function probeDoors(label: string, doors: readonly DoorDef[], walls: readonly WallDef[], rooms: readonly { id: string; rect: Rect }[]): ProbeReport {
  const wallById = new Map(walls.map(w => [w.id, w] as const));
  const roomById = new Map(rooms.map(r => [r.id, r] as const));
  const out: ProbeReport = { checked: 0, inside: 0, missing: [], wrong: [] };
  for (const d of doors) {
    const wall = wallById.get(d.wallId);
    if (!wall) continue;
    if (!drawsArc(d)) {
      assert.equal(swingArc(d, wall), null, `${label}: ${d.id} is ${d.motion} but draws an arc`);
      continue;
    }
    if (!d.swingIntoRoomId) {
      if (INSIDE_TYPES.has(d.type)) out.missing.push(`${label}: ${d.type} ${d.id} has no swingIntoRoomId`);
      continue;
    }
    const room = roomById.get(d.swingIntoRoomId);
    if (!room) { out.missing.push(`${label}: ${d.id} points at unknown room ${d.swingIntoRoomId}`); continue; }
    const p = swingProbe(d, wall);
    assert.ok(p, `${label}: ${d.id} is a swing door with no probe point`);
    out.checked++;
    if (inRect(reachRect(room.rect, wall), p!)) out.inside++;
    else out.wrong.push(`${label}: ${d.id} (${d.type}, hinge ${d.hinge}, swing ${d.swing}) probes ${p!.map(v => v.toFixed(2)).join(',')} outside ${room.id}`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// 1. the algebra
// ---------------------------------------------------------------------------------------------------------------

const WALL_X: WallDef = {
  id: 'W-X', storey: 'L01', start: [0, 0], end: [10, 0], thickness: 0.1, height: 2.7, type: 'partition',
  isExternal: false, loadBearingHint: false,
};
const WALL_MINUS_X: WallDef = { ...WALL_X, id: 'W-mX', start: [10, 0], end: [0, 0] };
const WALL_Y: WallDef = { ...WALL_X, id: 'W-Y', start: [0, 0], end: [0, 10] };
const WALL_MINUS_Y: WallDef = { ...WALL_X, id: 'W-mY', start: [0, 10], end: [0, 0] };
const FOUR_WALLS = [WALL_X, WALL_MINUS_X, WALL_Y, WALL_MINUS_Y];

function door(over: Partial<DoorDef> = {}): DoorDef {
  return {
    id: 'D', storey: 'L01', wallId: 'W-X', along: 5, width: 0.9, height: 2.1, type: 'interior',
    motion: 'swing', hinge: 'start', swing: 'left', ...over,
  };
}

test('doorOperation is the XOR of hinge and swing, for every motion', () => {
  const combos: [DoorHinge, DoorSwing, string][] = [
    ['start', 'left', 'LEFT'], ['start', 'right', 'RIGHT'],
    ['end', 'left', 'RIGHT'], ['end', 'right', 'LEFT'],
  ];
  for (const [hinge, swing, token] of combos) {
    assert.equal(doorOperation(door({ motion: 'swing', hinge, swing })), `SINGLE_SWING_${token}`);
    assert.equal(doorOperation(door({ motion: 'double-swing', hinge, swing })), `DOUBLE_SWING_${token}`);
    assert.equal(doorOperation(door({ motion: 'sliding', hinge, swing })), `SLIDING_TO_${token}`);
    assert.equal(doorOperation(door({ motion: 'folding', hinge, swing })), `FOLDING_TO_${token}`);
  }
  // two leaves lose the handing, and the motions that have none never had it
  assert.equal(doorOperation(door(), 2), 'DOUBLE_DOOR_SINGLE_SWING');
  assert.equal(doorOperation(door({ motion: 'double-swing' }), 2), 'DOUBLE_DOOR_DOUBLE_SWING');
  assert.equal(doorOperation(door({ motion: 'sliding' }), 2), 'DOUBLE_DOOR_SLIDING');
  assert.equal(doorOperation(door({ motion: 'folding' }), 2), 'DOUBLE_DOOR_FOLDING');
  assert.equal(doorOperation(door({ motion: 'rolling', swing: 'none' })), 'ROLLINGUP');
  assert.equal(doorOperation(door({ motion: 'opening', swing: 'none' })), 'NOTDEFINED');
});

test('only a swing leaf draws an arc', () => {
  const swings: DoorMotion[] = ['swing', 'double-swing'];
  const still: DoorMotion[] = ['sliding', 'folding', 'rolling', 'opening'];
  for (const motion of swings) {
    assert.equal(drawsArc(door({ motion })), true, motion);
    assert.ok(swingArc(door({ motion }), WALL_X), motion);
  }
  for (const motion of still) {
    assert.equal(drawsArc(door({ motion })), false, motion);
    assert.equal(swingArc(door({ motion }), WALL_X), null, motion);
    assert.equal(swingProbe(door({ motion }), WALL_X), null, motion);
  }
});

test('hinge, latch and leaf tip are the corners of one quarter square', () => {
  for (const wall of FOUR_WALLS) {
    for (const hinge of ['start', 'end'] as DoorHinge[]) {
      for (const swing of ['left', 'right'] as DoorSwing[]) {
        const d = door({ wallId: wall.id, hinge, swing });
        const h = hingePoint(d, wall);
        const l = latchPoint(d, wall);
        const tip = leafTip(d, wall);
        assert.ok(Math.abs(Math.hypot(l[0] - h[0], l[1] - h[1]) - d.width) < 1e-9, 'hinge → latch is one leaf');
        assert.ok(Math.abs(Math.hypot(tip[0] - h[0], tip[1] - h[1]) - d.width) < 1e-9, 'hinge → tip is one leaf');
        // latch and tip are the two ends of the 90° sweep, so they are a leaf-diagonal apart
        assert.ok(Math.abs(Math.hypot(tip[0] - l[0], tip[1] - l[1]) - d.width * Math.SQRT2) < 1e-9, 'sweep is 90°');
        // the light switch sits beyond the LATCH end, never the hinge end (ELE-05)
        const sw = latchSide(d, wall);
        assert.ok(Math.hypot(sw[0] - l[0], sw[1] - l[1]) < Math.hypot(sw[0] - h[0], sw[1] - h[1]),
          `latchSide is on the hinge side for ${wall.id}/${hinge}/${swing}`);
      }
    }
  }
});

test('the swing arc is 90° on all four wall directions', () => {
  for (const wall of FOUR_WALLS) {
    for (const swing of ['left', 'right'] as DoorSwing[]) {
      const arc = swingArc(door({ wallId: wall.id, swing }), wall);
      assert.ok(arc, wall.id);
      let delta = (arc!.toAngle - arc!.fromAngle) % (2 * Math.PI);
      if (delta > Math.PI) delta -= 2 * Math.PI;
      if (delta <= -Math.PI) delta += 2 * Math.PI;
      assert.ok(Math.abs(Math.abs(delta) - Math.PI / 2) < 1e-9,
        `${wall.id}/${swing}: sweep ${(delta * 180 / Math.PI).toFixed(1)}° is not a quarter turn`);
      assert.equal(arc!.ccw, delta > 0, `${wall.id}/${swing}: ccw disagrees with the sweep`);
    }
  }
});

test('reachRect answers "which side of the wall" for any wall thickness', () => {
  // a boundary wall's centreline sits outside the net room rect by half its thickness (0.1 m for a wet wall)
  const room: Rect = { x: 0, y: 0, w: 4, h: 3 };
  const outside: WallDef = { ...WALL_X, start: [0, -0.1], end: [4, -0.1], thickness: 0.2 };
  const r = reachRect(room, outside);
  assert.ok(inRect(r, [2, -0.1 + PROBE_DEPTH]), 'the probe on the room side is inside');
  assert.ok(!inRect(r, [2, -0.1 - PROBE_DEPTH]), 'the probe on the far side is outside');
  // and for a partition two rooms share, each room only claims its own side
  const shared: WallDef = { ...WALL_X, start: [0, 0], end: [4, 0], thickness: 0.1 };
  assert.ok(inRect(reachRect(room, shared), [2, PROBE_DEPTH]));
  assert.ok(!inRect(reachRect(room, shared), [2, -PROBE_DEPTH]));
});

// ---------------------------------------------------------------------------------------------------------------
// 2. every producer
// ---------------------------------------------------------------------------------------------------------------

test('every template on every access side: the leaf sweeps the room it serves', () => {
  let checked = 0;
  for (const t of Object.values(UNIT_TEMPLATES)) {
    for (const accessSide of ['front', 'rear', 'left', 'right'] as const) {
      for (let level = 0; level < t.storeysInUnit; level++) {
        const req = makeUnitRequest(t.id, accessSide, level);
        const layout = layoutUnit(req);
        const walls = [...layout.walls, ...Object.values(req.boundaryWalls).filter((w): w is WallDef => !!w)];
        const rep = probeDoors(`${t.id}/${accessSide}/L${level}`, layout.doors, walls, layout.rooms);
        assert.deepEqual(rep.missing, [], rep.missing.join('\n'));
        assert.deepEqual(rep.wrong, [], rep.wrong.join('\n'));
        checked += rep.checked;
        const typeOf = new Map(layout.rooms.map(r => [r.id, r.type] as const));
        for (const d of layout.doors) {
          const min = leafMinFor(d, typeOf);
          assert.ok(d.width >= min - 1e-6 || d.motion === 'opening',
            `${t.id}: ${d.type} ${d.id} is ${d.width.toFixed(2)} m, below the ${min} m minimum leaf`);
          assert.ok(d.ref && d.ref.length > 0, `${t.id}: ${d.id} has no program ref`);
        }
      }
    }
  }
  assert.ok(checked > 350, `only ${checked} swing doors probed`);
});

test('fixture floors: organiser, core and common-room doors sweep their own rooms', () => {
  for (const kind of FIXTURE_KINDS) {
    const fx = makeFixture(kind);
    const arch = generateArchitecture(fx.ctx);
    const rep = probeDoors(kind, arch.doors, arch.walls, arch.rooms);
    assert.deepEqual(rep.missing, [], rep.missing.join('\n'));
    assert.deepEqual(rep.wrong, [], rep.wrong.join('\n'));
    assert.ok(rep.checked > 0, `${kind}: no swing doors`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// 3. the ten presets (skipped automatically while disciplines/site is unavailable)
// ---------------------------------------------------------------------------------------------------------------

let generateSite: ((...a: never[]) => unknown) | null = null;
try {
  const m = await import('../site/index.ts') as { generateSite?: (...a: never[]) => unknown };
  generateSite = m.generateSite ?? null;
} catch {
  generateSite = null;
}

function archOf(presetId: string): { arch: ArchModel } {
  const preset = PRESETS.find(p => p.id === presetId)!;
  const spec = normalizeSpec(preset.spec);
  const typology = getTypology(spec.typology);
  const rng = createRng(spec.seed);
  const warnings: string[] = [];
  const site = (generateSite as unknown as (
    s: typeof spec, t: typeof typology, r: ReturnType<typeof createRng>, w: string[],
  ) => GenContext['site'])(spec, typology, rng.fork('site'), warnings);
  const ctx: GenContext = {
    spec, typology, rng: rng.fork('architecture'), storeys: site.massing.storeys, site,
    arch: null, struct: null, mech: null, plumb: null, elec: null, warnings,
  };
  return { arch: generateArchitecture(ctx) };
}

test('all ten presets: every swing door sweeps the room it says it does', { skip: !generateSite }, () => {
  let checked = 0;
  let inside = 0;
  const wrong: string[] = [];
  const missing: string[] = [];
  for (const p of PRESETS) {
    const { arch } = archOf(p.id);
    const rep = probeDoors(p.id, arch.doors, arch.walls, arch.rooms);
    checked += rep.checked;
    inside += rep.inside;
    wrong.push(...rep.wrong);
    missing.push(...rep.missing);
  }
  assert.ok(checked > 1500, `only ${checked} swing doors probed`);
  assert.deepEqual(missing, [], missing.slice(0, 5).join('\n'));
  assert.deepEqual(wrong, [], `${wrong.length} of ${checked} arcs land in the wrong room:\n${wrong.slice(0, 5).join('\n')}`);
  assert.equal(inside, checked);
});

test('all ten presets: the IFC operation token is derived and always a known enum value', { skip: !generateSite }, () => {
  // the writer's IfcDoorTypeOperationEnum whitelist (src/ifc/writer.ts)
  const KNOWN = new Set([
    'SINGLE_SWING_LEFT', 'SINGLE_SWING_RIGHT', 'DOUBLE_DOOR_SINGLE_SWING',
    'DOUBLE_SWING_LEFT', 'DOUBLE_SWING_RIGHT', 'DOUBLE_DOOR_DOUBLE_SWING', 'SLIDING_TO_LEFT',
    'SLIDING_TO_RIGHT', 'DOUBLE_DOOR_SLIDING', 'FOLDING_TO_LEFT', 'FOLDING_TO_RIGHT',
    'DOUBLE_DOOR_FOLDING', 'REVOLVING', 'ROLLINGUP', 'USERDEFINED', 'NOTDEFINED',
  ]);
  for (const p of PRESETS) {
    const { arch } = archOf(p.id);
    for (const d of arch.doors) {
      const token = doorOperation(d, d.width >= 1.35 ? 2 : 1);
      assert.ok(KNOWN.has(token), `${p.id}: ${d.id} derives ${token}`);
      // a cased opening and a shutter never claim a handing
      if (d.motion === 'opening') assert.equal(token, 'NOTDEFINED');
      if (d.motion === 'rolling') assert.equal(token, 'ROLLINGUP');
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------

const OPTIONS = {
  furniture: true, site: true, structure: true, mechanical: true, plumbing: true, electrical: true,
  detail: 'high' as const, ifcSchema: 'IFC4' as const,
};

/** A unit request with all four boundary walls present, the access side on `accessSide`, the rest exterior. */
function makeUnitRequest(
  id: UnitTemplateId, accessSide: Side, level: number,
): UnitLayoutRequest {
  const t = UNIT_TEMPLATES[id];
  const { frontage, depth } = recommendedRect(id);
  const horiz = accessSide === 'front' || accessSide === 'rear';
  const rect: Rect = { x: 3, y: 5, w: horiz ? frontage : depth, h: horiz ? depth : frontage };
  const wall = (wid: string, a: [number, number], b: [number, number], external: boolean): WallDef => ({
    id: wid, storey: 'L01', start: a, end: b, thickness: external ? 0.3 : 0.15, height: 2.7,
    type: external ? 'exterior' : 'corridor', isExternal: external, loadBearingHint: external,
  });
  const x0 = rect.x;
  const y0 = rect.y;
  const x1 = rect.x + rect.w;
  const y1 = rect.y + rect.h;
  // the organiser hands the layout engine boundary walls whose centrelines are OUTSIDE the net rect
  const o = (s: Side): number => (s === accessSide ? 0.075 : 0.15);
  const exterior = (['front', 'rear', 'left', 'right'] as Side[]).filter(s => s !== accessSide);
  return {
    unitId: `U-L01-${accessSide}`,
    template: t,
    rect,
    storey: 'L01',
    level,
    levelsTotal: t.storeysInUnit,
    accessSide,
    exteriorSides: exterior,
    exposures: { front: 'S', rear: 'N', left: 'E', right: 'W' },
    boundaryWalls: {
      front: wall('BW-front', [x0, y0 - o('front')], [x1, y0 - o('front')], accessSide !== 'front'),
      rear: wall('BW-rear', [x0, y1 + o('rear')], [x1, y1 + o('rear')], accessSide !== 'rear'),
      left: wall('BW-left', [x0 - o('left'), y0], [x0 - o('left'), y1], accessSide !== 'left'),
      right: wall('BW-right', [x1 + o('right'), y0], [x1 + o('right'), y1], accessSide !== 'right'),
    },
    floorToFloor: 3.0,
    ceilingHeight: 2.55,
    wwr: 0.35,
    balcony: null,
    region: 'US',
    options: OPTIONS,
    rng: createRng(`doors:${id}:${accessSide}:${level}`),
    wetWallSide: accessSide,
  };
}
