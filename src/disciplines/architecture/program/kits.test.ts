/**
 * Furniture-kit tests.
 *
 * The kit table is the source of every room minimum (`program/programs.ts` asserts each node against
 * `kitMinDims`), so the contract under test is: a room built at exactly the kit minimum takes the whole kit, with
 * the worst-case door swing in it. That is what turns "every kitchen has a sink, a range and a fridge" from a hope
 * into an invariant — in v1 the kitchen laid its run once, centred, and lost whatever the swing covered (5 kitchens
 * on `us-5-over-1` and 3 on `ie-courtyard` held nothing but a fridge, and plumbing then synthesised a sink).
 *
 *   node --test src/disciplines/architecture/program/kits.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { FurnitureType, Rect, RoomType } from '../../../core/types.ts';
import type { KitId } from './types.ts';
import {
  fitKit, kitFits, kitMandatory, kitMinDims, kitOneOf, triangleOf, KIT, KIT_IDS, TRIANGLE_MAX,
  type KitFace,
} from './kits.ts';
import { FURNITURE_CATALOG } from '../furniture.ts';
import { UNIT_TEMPLATES } from '../templates.ts';
import { layoutUnit } from '../unit-layout.ts';
import { createRng } from '../../../core/rng.ts';
import { recommendedRect } from '../templates.ts';

const FACES: KitFace[] = ['v+', 'v-', 'u+', 'u-'];

/** The design's §3.6 table — frozen, because `programs.ts` derives every room minimum from it */
const PUBLISHED: Partial<Record<KitId, [number, number]>> = {
  'kitchen-galley': [2.5, 1.8],
  'kitchen-galley-washer': [3.1, 1.8],
  'kitchen-island': [3.1, 3.3],
  'kitchen-accessible': [2.7, 2.7],
  'bath-3pc-tub': [1.7, 2.2],
  'bath-3pc-shower': [1.6, 2.0],
  'bath-accessible': [2.2, 2.6],
  'wc-2pc': [1.1, 1.5],
  'bed-double': [2.75, 3.2],
  'bed-single': [2.15, 2.9],
  'bed-master': [2.9, 3.4],
  'living-3seat': [3.4, 3.05],
  'living-kitchen': [3.6, 4.2],
  'dining-4': [2.7, 2.3],
  'dining-6': [3.3, 2.4],
  'laundry-stack': [0.8, 0.7],
  entry: [1.2, 1.5],
  'garage-1car': [3.0, 5.6],
};

/**
 * A room too tight for a leaf to stay clear of its fixtures (< 4.6 m² or a clear dimension under 1.55 m) and every
 * room of an accessible dwelling take an OUTWARD swinging door — the same rule `doorSpec` applies in
 * `unit-layout.ts` — so they are tested without a keep-out. Everything else must swallow a worst-case leaf.
 */
function swingsOutward(kit: KitId, min: { w: number; d: number }): boolean {
  return kit.includes('accessible') || min.w * min.d < 4.6 || Math.min(min.w, min.d) < 1.55;
}

/** A leaf-width keep-out square in the worst corner of one wall of `room` */
function keepOut(room: Rect, wall: 'front' | 'rear' | 'left' | 'right', end: 'lo' | 'hi', leaf = 0.8): Rect {
  switch (wall) {
    case 'front': return { x: end === 'lo' ? room.x : room.x + room.w - leaf, y: room.y, w: leaf, h: leaf };
    case 'rear': return { x: end === 'lo' ? room.x : room.x + room.w - leaf, y: room.y + room.h - leaf, w: leaf, h: leaf };
    case 'left': return { x: room.x, y: end === 'lo' ? room.y : room.y + room.h - leaf, w: leaf, h: leaf };
    default: return { x: room.x + room.w - leaf, y: end === 'lo' ? room.y : room.y + room.h - leaf, w: leaf, h: leaf };
  }
}

test('the kit table still publishes the design §3.6 minima', () => {
  for (const [kit, [w, d]] of Object.entries(PUBLISHED) as [KitId, [number, number]][]) {
    const min = kitMinDims(kit);
    assert.equal(min.w, w, `${kit} min width`);
    assert.equal(min.d, d, `${kit} min depth`);
  }
  // every kit id in the program vocabulary has an entry, and none is accidentally empty
  for (const kit of KIT_IDS) {
    const min = kitMinDims(kit);
    assert.ok(min.w >= 0 && min.d >= 0, kit);
    assert.ok(KIT[kit].source.length > 0, `${kit} has no clearance source`);
    if (kit !== 'none') assert.ok(min.w > 0 && min.d > 0, `${kit} has no minimum`);
  }
});

test('no mandatory item is larger than the room its kit claims to need', () => {
  for (const kit of KIT_IDS) {
    const min = kitMinDims(kit);
    const items = KIG(kit, min.w).filter(i => i.mandatory);
    const run = items.reduce((s, i) => s + i.w, 0);
    // a bath is a TWO-WALL kit by design (wc + basin on the wet wall, the tub or shower on a lateral wall), so the
    // run is allowed the perimeter of the two published dimensions — never more
    assert.ok(run <= min.w + min.d + 1e-6, `${kit}: mandatory run ${run.toFixed(2)} m exceeds ${min.w} + ${min.d} m`);
    for (const i of items) {
      assert.ok(i.w <= Math.max(min.w, min.d) + 1e-6, `${kit}: ${i.type} is ${i.w} m wide in a ${min.w} × ${min.d} m room`);
      assert.ok(i.d <= min.d + 1e-6, `${kit}: ${i.type} is ${i.d} m deep in a ${min.d} m room`);
    }
  }
});

test('fitKit places the complete kit at exactly kitMinDims, with the worst-case swing on each wall', () => {
  for (const kit of KIT_IDS) {
    if (kitMandatory(kit).length === 0 && kitOneOf(kit).length === 0) continue;
    const min = kitMinDims(kit);
    const outward = swingsOutward(kit, min);
    for (const orient of [0, 1]) {
      const room: Rect = orient === 0
        ? { x: 0, y: 0, w: min.w, h: min.d }
        : { x: 0, y: 0, w: min.d, h: min.w };
      for (const wall of ['front', 'rear', 'left', 'right'] as const) {
        for (const end of ['lo', 'hi'] as const) {
          for (const wetEdge of FACES) {
            const fit = fitKit({
              room, kit, wetEdge, setback: 0.1,
              swings: outward ? [] : [keepOut(room, wall, end)],
              opts: { detail: 'high', accessible: kit.includes('accessible') },
            });
            assert.ok(fit.ok,
              `${kit} at ${room.w} × ${room.h} m, swing ${wall}/${end}, wet ${wetEdge}: missing ${fit.missing.join(', ')}`);
            for (const it of fit.items) {
              assert.ok(it.aabb.x >= room.x - 1e-6 && it.aabb.y >= room.y - 1e-6
                && it.aabb.x + it.aabb.w <= room.x + room.w + 1e-6
                && it.aabb.y + it.aabb.h <= room.y + room.h + 1e-6, `${kit}: ${it.type} lies outside the room`);
            }
            // nothing overlaps anything else
            for (let i = 0; i < fit.items.length; i++) {
              for (let j = i + 1; j < fit.items.length; j++) {
                const a = fit.items[i].aabb;
                const b = fit.items[j].aabb;
                const hit = a.x + a.w > b.x + 1e-3 && b.x + b.w > a.x + 1e-3 && a.y + a.h > b.y + 1e-3 && b.y + b.h > a.y + 1e-3;
                assert.ok(!hit, `${kit}: ${fit.items[i].type} overlaps ${fit.items[j].type}`);
              }
            }
          }
        }
      }
    }
  }
});

test('fitKit is deterministic', () => {
  for (const kit of ['kitchen-galley', 'bath-3pc-tub', 'bed-master'] as KitId[]) {
    const min = kitMinDims(kit);
    const room: Rect = { x: 1.5, y: 2.5, w: min.w + 0.7, h: min.d + 0.4 };
    const args = { room, kit, wetEdge: 'v+' as KitFace, setback: 0.1, opts: { detail: 'high' as const } };
    assert.deepEqual(fitKit(args), fitKit(args), kit);
  }
});

test('the kitchen work triangle stays inside the NKBA band the room allows', () => {
  // A minimum-width galley is a straight 2.46 m run — sink 0.78 + range 0.83 + 1.61 = 3.22 m, which is the
  // geometric floor for three appliances in one line and below the design's 3.6 m aspiration. Above that the kit
  // opens the run out with counter fillers, or turns the fridge onto the return leg, until the triangle is inside
  // the 3.6–8.0 m band; it never exceeds the upper bound.
  const FLOOR = 3.2;
  const kitchens: KitId[] = [
    'kitchen-galley', 'kitchen-galley-washer', 'kitchen-island', 'kitchen-accessible', 'shared-kitchen',
    'living-kitchen',
  ];
  let inBand = 0;
  let total = 0;
  for (const kit of kitchens) {
    const min = kitMinDims(kit);
    for (let dw = 0; dw <= 2.0001; dw += 0.5) {
      for (let dd = 0; dd <= 2.0001; dd += 0.5) {
        const room: Rect = { x: 0, y: 0, w: min.w + dw, h: min.d + dd };
        const fit = fitKit({
          room, kit, wetEdge: 'v+', setback: 0.1,
          opts: { detail: 'high', big: true, accessible: kit.includes('accessible') },
        });
        assert.ok(fit.ok, `${kit} at ${room.w.toFixed(1)} × ${room.h.toFixed(1)}: missing ${fit.missing.join(', ')}`);
        assert.ok(fit.triangle > 0, `${kit} at ${room.w.toFixed(1)} × ${room.h.toFixed(1)}: no work triangle`);
        assert.ok(fit.triangle >= FLOOR - 1e-6 && fit.triangle <= TRIANGLE_MAX + 1e-6,
          `${kit} at ${room.w.toFixed(1)} × ${room.h.toFixed(1)}: triangle ${fit.triangle.toFixed(2)} m`);
        assert.equal(fit.triangle, triangleOf(fit.items));
        total++;
        if (fit.triangle >= 3.6) inBand++;
      }
    }
  }
  // most sizes reach the published band; only the tightest runs sit on the 3.22 m floor
  assert.ok(inBand / total > 0.5, `only ${inBand}/${total} kitchens reach 3.6 m`);
});

test('kitFits is the conservative predicate the program solver reads', () => {
  for (const kit of KIT_IDS) {
    const min = kitMinDims(kit);
    if (min.w <= 0) continue;
    assert.equal(kitFits({ x: 0, y: 0, w: min.w, h: min.d }, kit).ok, true, `${kit} at its minimum`);
    // …in either orientation
    assert.equal(kitFits({ x: 0, y: 0, w: min.d, h: min.w }, kit).ok, true, `${kit} rotated`);
    // …and not a centimetre under
    const under = kitFits({ x: 0, y: 0, w: min.w - 0.02, h: min.d - 0.02 }, kit);
    assert.equal(under.ok, false, `${kit} 20 mm under its minimum still claims to fit`);
    assert.ok(under.reason && under.reason.includes(kit));
  }
});

// ---------------------------------------------------------------------------------------------------------------
// the invariants, on every template
// ---------------------------------------------------------------------------------------------------------------

const KITCHENS = new Set<RoomType>(['kitchen', 'living-kitchen', 'shared-kitchen']);
const BATHS = new Set<RoomType>(['bathroom', 'ensuite', 'powder', 'wc']);
const BASIN: FurnitureType[] = ['lavatory', 'vanity'];
const BATHING: FurnitureType[] = ['shower', 'bathtub'];

test('every kitchen has a sink, a range and a fridge, and every bath a wc, a basin and a bathing fixture', () => {
  let kitchens = 0;
  let baths = 0;
  for (const t of Object.values(UNIT_TEMPLATES)) {
    for (const accessSide of ['front', 'rear', 'left', 'right'] as const) {
      for (let level = 0; level < t.storeysInUnit; level++) {
        const { frontage, depth } = recommendedRect(t.id);
        const horiz = accessSide === 'front' || accessSide === 'rear';
        const rect: Rect = { x: 3, y: 5, w: horiz ? frontage : depth, h: horiz ? depth : frontage };
        const layout = layoutUnit({
          unitId: `U-${t.id}`, template: t, rect, storey: 'L01', level, levelsTotal: t.storeysInUnit, accessSide,
          exteriorSides: (['front', 'rear', 'left', 'right'] as const).filter(s => s !== accessSide),
          exposures: { front: 'S', rear: 'N', left: 'E', right: 'W' },
          boundaryWalls: {
            front: bw('BW-front', [rect.x, rect.y - 0.15], [rect.x + rect.w, rect.y - 0.15]),
            rear: bw('BW-rear', [rect.x, rect.y + rect.h + 0.15], [rect.x + rect.w, rect.y + rect.h + 0.15]),
            left: bw('BW-left', [rect.x - 0.15, rect.y], [rect.x - 0.15, rect.y + rect.h]),
            right: bw('BW-right', [rect.x + rect.w + 0.15, rect.y], [rect.x + rect.w + 0.15, rect.y + rect.h]),
          },
          floorToFloor: 3, ceilingHeight: 2.55, wwr: 0.35, balcony: null, region: 'US',
          options: {
            furniture: true, site: true, structure: true, mechanical: true, plumbing: true, electrical: true,
            detail: 'high', ifcSchema: 'IFC4',
          },
          rng: createRng(`kits:${t.id}:${accessSide}:${level}`), wetWallSide: accessSide,
        });
        const items = new Map<string, FurnitureType[]>();
        for (const f of layout.furniture) {
          const l = items.get(f.roomId) ?? [];
          l.push(f.type);
          items.set(f.roomId, l);
        }
        for (const r of layout.rooms) {
          const got = items.get(r.id) ?? [];
          const label = `${t.id}/${accessSide}/L${level} ${r.name} ${r.rect.w.toFixed(2)} × ${r.rect.h.toFixed(2)}`;
          if (KITCHENS.has(r.type)) {
            kitchens++;
            for (const need of ['kitchen-sink', 'range', 'fridge'] as FurnitureType[]) {
              assert.ok(got.includes(need), `${label}: no ${need} (has ${got.join(', ') || 'nothing'})`);
            }
          }
          if (BATHS.has(r.type)) {
            baths++;
            assert.ok(got.includes('wc'), `${label}: no wc`);
            assert.ok(BASIN.some(b => got.includes(b)), `${label}: no basin`);
            if (r.type !== 'powder' && r.type !== 'wc') {
              assert.ok(BATHING.some(b => got.includes(b)), `${label}: no shower or bath`);
            }
          }
        }
      }
    }
  }
  assert.ok(kitchens > 50, `only ${kitchens} kitchens checked`);
  assert.ok(baths > 80, `only ${baths} baths checked`);
});

// ---------------------------------------------------------------------------------------------------------------

function KIG(kit: KitId, along: number): { type: FurnitureType; w: number; d: number; mandatory: boolean }[] {
  return KIT[kit].items(along, { detail: 'high', accessible: kit.includes('accessible') })
    .filter(i => i.w > 0)
    .map(i => ({ ...i, d: i.d > 0 ? i.d : FURNITURE_CATALOG[i.type].d }));
}

function bw(id: string, a: [number, number], b: [number, number]) {
  return {
    id, storey: 'L01', start: a, end: b, thickness: 0.15, height: 2.7, type: 'corridor' as const,
    isExternal: false, loadBearingHint: false,
  };
}
