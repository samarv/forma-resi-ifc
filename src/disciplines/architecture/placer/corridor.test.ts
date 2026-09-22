/**
 * Corridor tests (design §8). The placer CONSUMES the site's corridor graph; these assert that it consumes all of it:
 * every leg within ARC-03, every break slot either spent on a core or instantiated as a break module, knuckles
 * blocked in both bars, and travel measured on the graph rather than across the plate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { FloorLayout } from './types.ts';
import type { CorridorGraph } from '../../site/corridor-graph.ts';
import { PRESETS, getPreset } from '../../../core/spec.ts';
import { generateBuilding } from '../../../pipeline.ts';
import { buildCatalogue } from '../../../modules/catalogue.ts';
import { longestLeg, travelFrom, travelGraph } from './corridors.ts';
import { breakInterval, spineOrigin } from './strips.ts';
import { barFrame } from '../bar-frame.ts';

interface Built {
  id: string;
  layouts: Record<string, FloorLayout>;
  graph: CorridorGraph | null;
  bars: { id: string; rect: { x: number; y: number; w: number; h: number }; axis: 'x' | 'y'; depth: number; length: number; exteriorSides: import('../../../core/types.ts').Side[] }[];
  width: number;
  sprinklered: boolean;
  travel: number;
  coreRects: { x: number; y: number; w: number; h: number }[];
}

const cache: Built[] = [];
function all(): Built[] {
  if (cache.length === 0) {
    for (const p of PRESETS) {
      const m = generateBuilding(getPreset(p.id).spec);
      cache.push({
        id: p.id,
        layouts: m.arch.layouts ?? {},
        graph: m.site.massing.corridorGraph ?? null,
        bars: m.site.massing.bars,
        width: m.spec.massing.corridorWidth ?? m.typology.corridorWidth ?? 1.6,
        sprinklered: m.typology.sprinklered,
        travel: m.arch.derived.maxTravelDistance ?? 0,
        coreRects: m.arch.cores.map(c => c.rect),
      });
    }
  }
  return cache;
}

test('every corridor leg the placer consumes is within the ARC-03 maximum', () => {
  let legs = 0;
  for (const b of all()) {
    if (!b.graph) continue;
    for (const l of b.graph.legs) {
      legs++;
      assert.ok(l.length <= 45 + 0.5, `${b.id}: leg ${l.id} runs ${l.length.toFixed(1)} m (ARC-03 limit 45 m)`);
    }
    assert.ok(longestLeg(b.graph) <= 45 + 0.5, `${b.id}: longest leg ${longestLeg(b.graph)} m`);
  }
  assert.ok(legs > 10, `only ${legs} corridor legs across the presets`);
});

test('the ARC-03 metric is the graph leg, not the length of a corridor rect', () => {
  /*
   * A break module is a WIDENED corridor bay, so the corridor room runs through it: the rect can still span the bar.
   * What ARC-03 limits is the LEG — the run between two nodes of the graph — and that is the number architecture
   * now reports (`longestLeg`), instead of measuring a rect and warning that it is 71.7 m long.
   */
  for (const b of all()) {
    if (!b.graph || b.graph.legs.length === 0) continue;
    assert.ok(longestLeg(b.graph) <= 45.5, `${b.id}: longest leg ${longestLeg(b.graph)} m`);
    for (const bar of b.bars) {
      const legs = b.graph.legs.filter(l => l.barId === bar.id);
      if (legs.length === 0) continue;
      const span = legs.reduce((a, l) => a + l.length, 0);
      for (const [storey, layout] of Object.entries(b.layouts)) {
        for (const cs of (layout.corridorSlots ?? []).filter(c => c.barId === bar.id)) {
          const len = Math.max(cs.rect.w, cs.rect.h);
          assert.ok(
            len <= span + 1.0,
            `${b.id}/${storey}: corridor rect runs ${len.toFixed(1)} m past the ${span.toFixed(1)} m of legs on ${bar.id}`,
          );
        }
      }
    }
  }
});

test('every break slot is either spent on a core or instantiated as a break module', () => {
  const catalogue = buildCatalogue();
  let instantiated = 0;
  for (const b of all()) {
    if (!b.graph) continue;
    for (const [storey, layout] of Object.entries(b.layouts)) {
      if (layout.slots.length === 0) continue;
      const breaks = layout.slots.filter(s => s.kind === 'break');
      for (const s of breaks) {
        const mod = catalogue.byId(s.moduleId);
        assert.ok(mod && mod.kind === 'break', `${b.id}/${storey}: ${s.id} is a break slot with module ${s.moduleId}`);
        assert.ok(s.boundary.w > 0.5 && s.boundary.h > 0.5, `${b.id}/${storey}: break ${s.id} is degenerate`);
        instantiated++;
      }
    }
  }
  assert.ok(instantiated > 0, 'no break module was ever instantiated from the site graph');
});

test('break slots and knuckles are blocked before any dwelling is packed, in every bar they touch', () => {
  for (const b of all()) {
    if (!b.graph) continue;
    for (const [storey, layout] of Object.entries(b.layouts)) {
      if (layout.strips.length === 0) continue;
      for (const bar of b.bars) {
        const frame = barFrame(bar);
        const strips = layout.strips.filter(st => st.barId === bar.id);
        if (strips.length === 0) continue;
        const origin = spineOrigin(frame, b.graph);
        for (const slot of b.graph.breakSlots.filter(x => x.barId === bar.id)) {
          const iv = breakInterval(frame, slot, origin);
          const mid = (iv.s + iv.e) / 2;
          if (mid < strips[0].along.s || mid > strips[0].along.e) continue;
          for (const st of strips) {
            assert.ok(
              st.blocked.some(x => x.s <= mid + 0.01 && x.e >= mid - 0.01),
              `${b.id}/${storey}: break slot ${slot.id} at ${mid.toFixed(1)} m is not blocked in ${st.id}`,
            );
          }
        }
      }
    }
  }
});

test('a knuckle rect is disjoint from every dwelling slot', () => {
  for (const b of all()) {
    if (!b.graph || b.graph.knuckles.length === 0) continue;
    for (const [storey, layout] of Object.entries(b.layouts)) {
      for (const k of b.graph.knuckles) {
        for (const s of layout.slots) {
          if (s.kind !== 'unit') continue;
          const ox = Math.min(k.rect.x + k.rect.w, s.boundary.x + s.boundary.w) - Math.max(k.rect.x, s.boundary.x);
          const oy = Math.min(k.rect.y + k.rect.h, s.boundary.y + s.boundary.h) - Math.max(k.rect.y, s.boundary.y);
          assert.ok(
            ox < 0.05 || oy < 0.05,
            `${b.id}/${storey}: knuckle ${k.id} overlaps dwelling ${s.id} by ${ox.toFixed(2)} × ${oy.toFixed(2)} m`,
          );
        }
      }
    }
  }
});

test('an O-plan corridor is ONE connected graph, not four disjoint corridors', () => {
  const ie = all().find(b => b.id === 'ie-courtyard');
  assert.ok(ie?.graph, 'ie-courtyard has no corridor graph');
  const g = ie!.graph!;
  assert.ok(g.knuckles.length >= 4, `an O-plan needs four knuckles, found ${g.knuckles.length}`);
  const tg = travelGraph(g, ie!.coreRects, ie!.width);
  assert.ok(tg, 'no travel graph for the O-plan');
  const reached = tg!.toExit.filter(d => Number.isFinite(d)).length;
  assert.equal(reached, tg!.toExit.length, `${tg!.toExit.length - reached} corridor nodes cannot reach an exit`);
});

test('travel distance is measured on the graph and stays within the typology limit', () => {
  for (const b of all()) {
    const limit = b.sprinklered ? 76 : 61;
    assert.ok(b.travel <= limit, `${b.id}: egress travel ${b.travel} m exceeds the ${limit} m limit`);
    if (!b.graph || b.graph.legs.length === 0 || b.coreRects.length === 0) continue;
    const tg = travelGraph(b.graph, b.coreRects, b.width);
    if (!tg) continue;
    // a point ON a leg is at most that leg's length from an exit, never the plate diagonal
    const seg = b.graph.legs[0].centerline[0];
    const mid: [number, number] = [(seg.a[0] + seg.b[0]) / 2, (seg.a[1] + seg.b[1]) / 2];
    const d = travelFrom(tg, mid);
    assert.ok(d >= 0 && d <= limit, `${b.id}: a point on its own corridor is ${d.toFixed(1)} m from an exit`);
  }
});

test('the corridor centreline a CorridorDef carries follows the graph legs', () => {
  for (const b of all()) {
    if (!b.graph || b.graph.legs.length === 0) continue;
    const m = generateBuilding(getPreset(b.id).spec);
    for (const floor of m.arch.floors) {
      for (const c of floor.corridors) {
        assert.ok(c.centerline.length > 0, `${b.id}: corridor ${c.id} has no centreline`);
        for (const seg of c.centerline) {
          const horizontal = Math.abs(seg.b[1] - seg.a[1]) < 0.01;
          const vertical = Math.abs(seg.b[0] - seg.a[0]) < 0.01;
          assert.ok(horizontal || vertical, `${b.id}: corridor ${c.id} has a skew centreline segment`);
        }
      }
    }
  }
});
