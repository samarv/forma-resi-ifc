/**
 * `clampUnitEdit` — total, pure, idempotent.
 *
 * The editor draws its ghost from this function and `applyOverrides` forwards its result to the solver,
 * so the three properties below are the whole correctness argument for direct manipulation: whatever the
 * pointer is doing, the function answers; clamping an already-clamped edit changes nothing; and `range`
 * is the closed interval the overlay draws its rail along.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { GenerationOptions, Rect, Side, Vec2, WallDef } from '../../../core/types.ts';
import type { UnitEdit } from '../../../core/overrides.ts';
import type { ClampCtx } from '../placer/types.ts';
import type { UnitBoundaryWalls, UnitLayout, UnitLayoutRequest } from '../unit-layout-types.ts';
import { UNIT_TEMPLATES } from '../templates.ts';
import { createRng } from '../../../core/rng.ts';
import { SIZES } from '../../../core/coordination.ts';
import { programFor } from './programs.ts';
import { layoutUnitV2 } from './solver.ts';
import { clampUnitEdit } from './clamp.ts';

const OPTIONS: GenerationOptions = {
  furniture: true, site: true, structure: true, mechanical: true, plumbing: true, electrical: true,
  detail: 'high', ifcSchema: 'IFC4',
};

function boundaryWalls(rect: Rect, access: Side, ext: Side[]): UnitBoundaryWalls {
  const th = (s: Side): number => (ext.includes(s) ? SIZES.exteriorWallT : s === access ? SIZES.corridorWallT : SIZES.partyWallT);
  const mk = (s: Side, a: Vec2, b: Vec2): WallDef => ({
    id: `ORG-L01-${s.toUpperCase()}`,
    storey: 'L01',
    start: a,
    end: b,
    thickness: th(s),
    height: 2.8,
    type: ext.includes(s) ? 'exterior' : s === access ? 'corridor' : 'party',
    isExternal: ext.includes(s),
    loadBearingHint: true,
  });
  const x0 = rect.x;
  const y0 = rect.y;
  const x1 = rect.x + rect.w;
  const y1 = rect.y + rect.h;
  return {
    front: mk('front', [x0, y0 - th('front') / 2], [x1, y0 - th('front') / 2]),
    right: mk('right', [x1 + th('right') / 2, y0], [x1 + th('right') / 2, y1]),
    rear: mk('rear', [x1, y1 + th('rear') / 2], [x0, y1 + th('rear') / 2]),
    left: mk('left', [x0 - th('left') / 2, y1], [x0 - th('left') / 2, y0]),
  };
}

function fixture(): { layout: UnitLayout; ctx: ClampCtx; req: UnitLayoutRequest } {
  const t = UNIT_TEMPLATES['2b2b'];
  const rect: Rect = { x: 12, y: 7, w: 9.7, h: 9.5 };
  const req: UnitLayoutRequest = {
    unitId: 'U-L01-04',
    template: t,
    rect,
    storey: 'L01',
    level: 0,
    levelsTotal: 1,
    accessSide: 'front',
    exteriorSides: ['rear'],
    exposures: { front: 'N', rear: 'S' },
    boundaryWalls: boundaryWalls(rect, 'front', ['rear']),
    floorToFloor: 3.0,
    ceilingHeight: 2.7,
    wwr: 0.35,
    balcony: null,
    region: 'US',
    options: OPTIONS,
    rng: createRng(7),
    wetWallSide: 'front',
  };
  const layout = layoutUnitV2(req);
  // ClampCtx's catalogue and grid belong to the placer; the unit clamp reads neither, so the fixture
  // passes the narrowest thing that satisfies the type.
  const ctx = {
    catalogue: undefined as never,
    grid: undefined as never,
    rules: undefined as never,
    region: 'US',
    level: 0,
  } as unknown as ClampCtx;
  return { layout, ctx, req };
}

const { layout, ctx } = fixture();
const program = programFor('2b2b');
const clamp = (e: UnitEdit): ReturnType<typeof clampUnitEdit> => clampUnitEdit(layout, e, program, ctx);

const refOfPartition = (): string => {
  const w = layout.walls.find(x => x.type === 'partition' && x.leftRoomId && x.rightRoomId);
  if (!w) throw new Error('fixture has no partition');
  const a = layout.rooms.find(r => r.id === w.leftRoomId)?.ref ?? '';
  const b = layout.rooms.find(r => r.id === w.rightRoomId)?.ref ?? '';
  return [a, b].join('|');
};

// ---------------------------------------------------------------------------------------------------

test('the fixture has the refs the editor addresses things by', () => {
  assert.ok(layout.rooms.every(r => r.ref && r.ref.length > 2), 'every room needs a program ref');
  assert.ok(layout.doors.some(d => d.ref && d.ref.includes('~')), 'interior doors need a <from>~<to> ref');
  assert.ok((layout.swings ?? []).length > 0, 'the clamp needs the door-swing keep-outs');
});

test('clampUnitEdit is total: unknown refs, silly numbers and wrong ops are refusals, never throws', () => {
  const nonsense: UnitEdit[] = [
    { op: 'flipDoor', doorRef: 'no-such-door' },
    { op: 'reverseDoor', doorRef: '' },
    { op: 'moveDoor', doorRef: 'nope', along: Number.NaN },
    { op: 'setDoorMotion', doorRef: 'nope', motion: 'swing' },
    { op: 'dragPartition', edgeRef: 'not|a|partition', delta: 1e9 },
    { op: 'dragPartition', edgeRef: '', delta: -1e9 },
    { op: 'moveFurniture', itemRef: 'ghost', du: Infinity, dv: -Infinity },
    { op: 'addFurniture', roomRef: 'nowhere', type: 'sofa-3', u: 0, v: 0, rotation: 0 },
    { op: 'removeFurniture', itemRef: 'ghost' },
    { op: 'swapRoomType', roomRef: 'nowhere', type: 'kitchen' },
    { op: 'swapRoomType', roomRef: 'bathroom1', type: 'parking' },
  ];
  for (const e of nonsense) {
    const r = clamp(e);
    assert.equal(r.ok, false, `${e.op} on nonsense should be refused`);
    assert.ok((r.reason ?? '').length > 5, `${e.op}: a refusal must say why`);
    assert.equal(r.edit.op, e.op, 'the returned edit keeps its op');
  }
});

test('moveDoor clamps into a free span of its own wall and reports the rail', () => {
  const door = layout.doors.find(d => d.ref && d.ref.includes('~') && layout.walls.some(w => w.id === d.wallId));
  assert.ok(door, 'fixture needs an interior door');
  const ref = door!.ref as string;
  const far = clamp({ op: 'moveDoor', doorRef: ref, along: 999 });
  assert.equal(far.ok, true, far.reason);
  assert.ok(far.range, 'moveDoor must publish its rail');
  const [lo, hi] = far.range!;
  assert.ok(lo <= hi + 1e-9);
  const along = (far.edit as { along: number }).along;
  assert.ok(along >= lo - 1e-6 && along <= hi + 1e-6, `${along} outside the rail ${lo}–${hi}`);
  // idempotent
  const again = clamp(far.edit);
  assert.deepEqual(again.edit, far.edit, 'clamping a clamped moveDoor changed it');
  // and the negative side
  const near = clamp({ op: 'moveDoor', doorRef: ref, along: -50 });
  assert.equal(near.ok, true, near.reason);
  assert.ok((near.edit as { along: number }).along >= near.range![0] - 1e-6);
  // every committed scalar is a multiple of 5 mm so reruns stay byte-identical
  const q = (near.edit as { along: number }).along / 0.005;
  assert.ok(Math.abs(q - Math.round(q)) < 1e-6, 'along is not on the 5 mm quantum');
});

test('dragPartition is bounded by both rooms keeping their kit, and is idempotent', () => {
  const edgeRef = refOfPartition();
  const out = clamp({ op: 'dragPartition', edgeRef, delta: 99 });
  assert.ok(out.range, 'dragPartition must publish its rail');
  const [lo, hi] = out.range!;
  assert.ok(lo <= 0 + 1e-9 && hi >= 0 - 1e-9, `the rail ${lo}–${hi} should contain 0 (no move)`);
  if (out.ok) {
    const delta = (out.edit as { delta: number }).delta;
    assert.ok(delta >= lo - 1e-6 && delta <= hi + 1e-6, `${delta} outside the rail`);
    const again = clamp(out.edit);
    // a second clamp of the same scalar is either the same edit or a refused no-op
    if (again.ok) assert.deepEqual(again.edit, out.edit, 'dragPartition is not idempotent');
  }
  const back = clamp({ op: 'dragPartition', edgeRef, delta: -99 });
  assert.ok(back.range, 'the rail is published even when the drag is refused');
  const zero = clamp({ op: 'dragPartition', edgeRef, delta: 0 });
  assert.equal(zero.ok, false, 'a zero drag is a no-op, not an edit');
});

test('moveFurniture keeps the item in its room, out of the swings and off the other items', () => {
  const item = layout.furniture.find(f => f.type === 'bed-queen' || f.type === 'bed-double' || f.type === 'sofa-3');
  assert.ok(item, 'fixture needs a piece of furniture');
  const ref = (item!.ref ?? item!.id) as string;
  const out = clamp({ op: 'moveFurniture', itemRef: ref, du: 40, dv: 40 });
  // either it found a nearer legal offset, or it refused — both are answers, neither throws
  if (out.ok) {
    const e = out.edit as { du: number; dv: number };
    assert.ok(Math.hypot(e.du, e.dv) <= Math.hypot(40, 40) + 1e-9, 'the clamp moved it further than asked');
    const again = clamp(out.edit);
    assert.equal(again.ok, true, 'a clamped move should stay legal');
    assert.deepEqual(again.edit, out.edit, 'moveFurniture is not idempotent');
  } else {
    assert.ok((out.reason ?? '').length > 5);
  }
  // a zero move is always legal
  const still = clamp({ op: 'moveFurniture', itemRef: ref, du: 0, dv: 0 });
  assert.equal(still.ok, true, still.reason);
  // rotation is quantised to right angles
  const spun = clamp({ op: 'moveFurniture', itemRef: ref, du: 0, dv: 0, rotate: 1.2 });
  if (spun.ok) {
    const rot = (spun.edit as { rotate?: number }).rotate ?? 0;
    const q = rot / (Math.PI / 2);
    assert.ok(Math.abs(q - Math.round(q)) < 1e-9, `rotation ${rot} is not a right angle`);
  }
});

test('addFurniture needs a clear position; removeFurniture refuses to break a kit', () => {
  const bed = layout.rooms.find(r => r.type === 'master-bedroom' || r.type === 'bedroom');
  assert.ok(bed, 'fixture needs a bedroom');
  const outside = clamp({ op: 'addFurniture', roomRef: bed!.ref as string, type: 'sofa-3', u: 1e6, v: 1e6, rotation: 0 });
  assert.equal(outside.ok, false, 'a position outside the room must be refused');
  const centre = clamp({
    op: 'addFurniture', roomRef: bed!.ref as string, type: 'chair',
    u: bed!.rect.x + bed!.rect.w / 2, v: bed!.rect.y + bed!.rect.h / 2, rotation: 0,
  });
  // the middle of a furnished bedroom may well be taken; whichever way, the answer is reasoned
  assert.ok(centre.ok || (centre.reason ?? '').length > 5);

  const sink = layout.furniture.find(f => f.type === 'kitchen-sink');
  if (sink) {
    const r = clamp({ op: 'removeFurniture', itemRef: (sink.ref ?? sink.id) as string });
    assert.equal(r.ok, false, 'the sink is part of the kitchen kit and must not be removable');
  }
  const extra = layout.furniture.find(f => f.type === 'nightstand' || f.type === 'coffee-table');
  if (extra) {
    const r = clamp({ op: 'removeFurniture', itemRef: (extra.ref ?? extra.id) as string });
    assert.equal(r.ok, true, `an optional item should be removable: ${r.reason}`);
    assert.deepEqual(clamp(r.edit).edit, r.edit);
  }
});

test('door flips need a leaf, and a swing motion needs a room that can hold it', () => {
  const swing = layout.doors.find(d => d.motion === 'swing' && d.ref);
  const sliding = layout.doors.find(d => d.motion === 'sliding' && d.ref);
  if (swing) {
    const f = clamp({ op: 'flipDoor', doorRef: swing.ref as string });
    assert.equal(f.ok, true, f.reason);
    assert.deepEqual(clamp(f.edit).edit, f.edit);
    const rev = clamp({ op: 'reverseDoor', doorRef: swing.ref as string });
    assert.equal(rev.ok, true, rev.reason);
  }
  if (sliding) {
    const f = clamp({ op: 'flipDoor', doorRef: sliding.ref as string });
    assert.equal(f.ok, false, 'a sliding door has no hinge to flip');
    const m = clamp({ op: 'setDoorMotion', doorRef: sliding.ref as string, motion: 'sliding' });
    assert.equal(m.ok, true, m.reason);
  }
});

test('swapRoomType only allows a type whose kit fits the room as built', () => {
  const bath = layout.rooms.find(r => r.type === 'bathroom');
  assert.ok(bath, 'fixture needs a bathroom');
  const toBed = clamp({ op: 'swapRoomType', roomRef: bath!.ref as string, type: 'master-bedroom' });
  assert.equal(toBed.ok, false, 'a 2 m wide bathroom cannot become a principal bedroom');
  const toWc = clamp({ op: 'swapRoomType', roomRef: bath!.ref as string, type: 'wc' });
  assert.equal(toWc.ok, true, toWc.reason);
  assert.deepEqual(clamp(toWc.edit).edit, toWc.edit);
});

test('clampUnitEdit is pure: it never mutates the layout it is handed', () => {
  const before = JSON.stringify(layout);
  const edgeRef = refOfPartition();
  clamp({ op: 'dragPartition', edgeRef, delta: 0.5 });
  clamp({ op: 'moveFurniture', itemRef: (layout.furniture[0]?.ref ?? layout.furniture[0]?.id ?? 'x') as string, du: 1, dv: 1 });
  clamp({ op: 'moveDoor', doorRef: (layout.doors[1]?.ref ?? 'x') as string, along: 3 });
  assert.equal(JSON.stringify(layout), before, 'the clamp mutated the layout');
});
