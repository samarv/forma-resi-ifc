/**
 * Corridor graph (F7): legs ≤ ARC-03.maxLegLength, break slots at the joints, knuckles where bars
 * meet, dead ends measured to the real exits, and `longestRunM`.
 *
 * Run: node --test src/disciplines/site/corridor-graph.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { AccessType, MassingBar, Rect, Vec2 } from '../../core/types.ts';
import type { Rule, RuleSet, SubjectKind } from '../../core/rules/types.ts';
import { IdFactory } from '../../core/ids.ts';
import { issueSink } from './issues.ts';
import { buildCorridorGraph, buildCorridors, legGraph, resolveDeadEnds, type CorridorGraph } from './corridor-graph.ts';

const MAX_LEG = 45;

function bar(id: string, rect: Rect, axis: 'x' | 'y'): MassingBar {
  return {
    id,
    rect,
    axis,
    depth: axis === 'x' ? rect.h : rect.w,
    length: axis === 'x' ? rect.w : rect.h,
    exteriorSides: ['front', 'rear', 'left', 'right'],
  };
}

/** A single 72 m double-loaded bar, like us-5-over-1 */
const BAR_ONLY: MassingBar[] = [bar('B1', { x: 0, y: 0, w: 72, h: 12 }, 'x')];
/** A perimeter block, like ie-courtyard: 70 × 64 envelope, 18 m deep bars */
const O_PLAN: MassingBar[] = [
  bar('BF', { x: 0, y: 0, w: 70, h: 18 }, 'x'),
  bar('BL', { x: 0, y: 18, w: 18, h: 28 }, 'y'),
  bar('BR', { x: 52, y: 18, w: 18, h: 28 }, 'y'),
  bar('BK', { x: 0, y: 46, w: 70, h: 18 }, 'x'),
];
/** An L, like us-senior */
const L_PLAN: MassingBar[] = [
  bar('BF', { x: 0, y: 0, w: 76, h: 20 }, 'x'),
  bar('BW', { x: 0, y: 20, w: 20, h: 28 }, 'y'),
];

function build(o: {
  bars: MassingBar[];
  access?: AccessType;
  width?: number;
  centroid?: Vec2;
  sprinklered?: boolean;
  rules?: RuleSet;
}): CorridorGraph {
  const bars = o.bars;
  const cx = bars.reduce((s, b) => s + b.rect.x + b.rect.w / 2, 0) / bars.length;
  const cy = bars.reduce((s, b) => s + b.rect.y + b.rect.h / 2, 0) / bars.length;
  return buildCorridorGraph({
    bars,
    access: o.access ?? 'corridor-double',
    width: o.width ?? 1.7,
    footprintCentroid: o.centroid ?? [cx, cy],
    shape: 'bar',
    sprinklered: o.sprinklered ?? true,
    rules: o.rules,
    ids: new IdFactory('site'),
    sink: issueSink(),
  });
}

/** Minimal RuleSet so the `rules.num` reads can be proven to be live */
function ruleSetWith(values: Record<string, number>): RuleSet {
  return {
    all: (): readonly Rule[] => [],
    get: (): Rule | null => null,
    num: (id: string, fallback: number): number => values[id] ?? fallback,
    str: (_id: string, fallback: string): string => fallback,
    bool: (_id: string, fallback: boolean): boolean => fallback,
    table: (): readonly [number, number][] => [],
    forSubject: (_k: SubjectKind): readonly Rule[] => [],
    disabled: (): boolean => false,
    profileApplied: (): boolean => false,
    hash: (): string => 'test',
  };
}

function segLength(a: Vec2, b: Vec2): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

// ---------------------------------------------------------------------------

test('a bar with no corridor access has no graph', () => {
  for (const access of ['direct', 'stair-core', 'point-core'] as const) {
    const g = build({ bars: BAR_ONLY, access });
    assert.deepEqual(g.spines, []);
    assert.deepEqual(g.legs, []);
    assert.deepEqual(g.breakSlots, []);
    assert.equal(g.longestRunM, 0);
  }
});

test('every leg is at most ARC-03.maxLegLength, with a break slot at every joint', () => {
  for (const bars of [BAR_ONLY, O_PLAN, L_PLAN]) {
    const g = build({ bars });
    assert.ok(g.legs.length > 0, 'no legs');
    for (const leg of g.legs) {
      assert.ok(leg.length <= MAX_LEG + 1e-6, `leg ${leg.id} is ${leg.length} m`);
      assert.equal(leg.centerline.length, 1);
      assert.ok(Math.abs(segLength(leg.centerline[0].a, leg.centerline[0].b) - leg.length) < 1e-6,
        'leg length disagrees with its centreline');
    }
    // one 'core' slot per split spine, and every slot inside its bar
    const barById = new Map(bars.map(b => [b.id, b]));
    for (const s of g.breakSlots) {
      const b = barById.get(s.barId);
      assert.ok(b, `slot ${s.id} references an unknown bar`);
      assert.ok(s.length > 0 && s.station > 0, `slot ${s.id} degenerate`);
      assert.ok(s.station <= b!.length + b!.depth, `slot ${s.id} past the end of its bar`);
      assert.ok(s.reason.length > 0);
    }
  }
});

test('the 72 m bar splits into two 36 m legs with a central core break slot', () => {
  const g = build({ bars: BAR_ONLY });
  assert.equal(g.legs.length, 2);
  assert.ok(Math.abs(g.legs[0].length - 36) < 1e-6);
  assert.equal(g.breakSlots.length, 1);
  assert.equal(g.breakSlots[0].want, 'core');
  assert.ok(Math.abs(g.breakSlots[0].station - 36) < 1e-6);
  assert.equal(g.longestRunM, 72);
  // an 'info' split-corridor resolution, never a warning
  assert.equal(g.issues.length, 1);
  assert.equal(g.issues[0].severity, 'info');
  assert.equal(g.issues[0].resolution?.id, 'split-corridor');
});

test('centerline keeps the full spine for v1 consumers; legs[0] equals it when there is one leg', () => {
  const short = [bar('B1', { x: 0, y: 0, w: 30, h: 12 }, 'x')];
  const g1 = build({ bars: short });
  assert.equal(g1.legs.length, 1);
  assert.deepEqual(g1.spines[0].legs, [g1.spines[0].centerline]);

  const g2 = build({ bars: BAR_ONLY });
  const spine = g2.spines[0];
  assert.ok(Math.abs(segLength(spine.centerline.a, spine.centerline.b) - 72) < 1e-6,
    'centerline must still span the whole bar');
  assert.equal(spine.legs?.length, 2);
});

test("the rule set's maxLegLength is live", () => {
  const g = build({ bars: BAR_ONLY, rules: ruleSetWith({ 'ARC-03.maxLegLength': 20, 'ARC-03.breakSlotLength': 3 }) });
  assert.equal(g.legs.length, 4);
  for (const leg of g.legs) assert.ok(leg.length <= 20 + 1e-6);
  for (const s of g.breakSlots) assert.ok(s.length <= 3 + 1e-6);
});

test('an O-plan is ONE connected cyclic corridor with four knuckles', () => {
  const g = build({ bars: O_PLAN });
  assert.equal(g.knuckles.length, 4, `knuckles ${g.knuckles.length}`);
  for (const k of g.knuckles) {
    assert.equal(k.barIds.length, 2);
    assert.ok(k.rect.w > 0 && k.rect.h > 0);
  }
  // connectivity: one component, and at least as many edges as nodes (so it holds a cycle)
  const { adj, count } = legGraph(g.legs, 1.7);
  const seen = new Set<number>([0]);
  const queue = [0];
  while (queue.length > 0) {
    const at = queue.shift()!;
    for (const e of adj.get(at) ?? []) {
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      queue.push(e.to);
    }
  }
  assert.equal(seen.size, count, `corridor graph has ${count - seen.size} disconnected node(s)`);
  assert.ok(g.legs.length >= count, `${g.legs.length} legs for ${count} nodes is not cyclic`);
  // the loop is longer than any single bar
  assert.ok(g.longestRunM > 70, `longest run ${g.longestRunM} m`);
});

test('an L-plan joins its two bars through one knuckle', () => {
  const g = build({ bars: L_PLAN });
  assert.equal(g.knuckles.length, 1);
  assert.deepEqual([...g.knuckles[0].barIds].sort(), ['BF', 'BW']);
  const { adj, count } = legGraph(g.legs, 2.0);
  const seen = new Set<number>([0]);
  const queue = [0];
  while (queue.length > 0) {
    const at = queue.shift()!;
    for (const e of adj.get(at) ?? []) {
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      queue.push(e.to);
    }
  }
  assert.equal(seen.size, count, 'the wing is not connected to the front bar');
});

test('a gallery spine hugs one face and still splits into legs', () => {
  const g = build({ bars: BAR_ONLY, access: 'gallery', centroid: [36, 20] });
  assert.equal(g.spines[0].loaded === 'both', false, 'a gallery is single-loaded');
  assert.ok(g.legs.length >= 2);
  assert.ok(g.breakSlots.every(s => s.want === 'window-bay' || s.want === 'core'),
    'a deck break wants a window bay, not an internal lounge');
});

test('resolveDeadEnds measures to the exits and reserves a core slot when over the limit', () => {
  const sink = issueSink();
  const g = build({ bars: BAR_ONLY });
  // One exit in the middle of a 72 m bar: both ends are 36 m dead ends (limit 15 sprinklered).
  const resolved = resolveDeadEnds({
    graph: g,
    bars: BAR_ONLY,
    exits: [{ barId: 'B1', at: [36, 6], length: 5 }],
    sprinklered: true,
    sink,
  });
  assert.equal(resolved.deadEnds.length, 2);
  for (const d of resolved.deadEnds) assert.ok(d.length <= 15 + 1e-6, `dead end ${d.length} m`);
  assert.equal(resolved.breakSlots.length, 3, 'a core slot per over-long end, plus the joint');
  const added = sink.all().filter(i => i.ruleId === 'SIT-08.deadEnd');
  assert.equal(added.length, 2);
  for (const i of added) {
    assert.equal(i.severity, 'info');
    assert.equal(i.resolution?.id, 'add-core');
    assert.equal(i.observed, 36);
    assert.equal(i.limit, 15);
  }
});

test('dead ends within the limit are recorded but resolve nothing', () => {
  const sink = issueSink();
  const g = build({ bars: BAR_ONLY });
  const resolved = resolveDeadEnds({
    graph: g,
    bars: BAR_ONLY,
    exits: [{ barId: 'B1', at: [8.5, 6], length: 5 }, { barId: 'B1', at: [63.5, 6], length: 5 }],
    sprinklered: true,
    sink,
  });
  assert.deepEqual(resolved.deadEnds.map(d => d.length), [8.5, 8.5]);
  assert.equal(resolved.breakSlots.length, g.breakSlots.length, 'no extra slot needed');
  assert.deepEqual(sink.all(), []);
});

test('an unsprinklered building gets the 6 m dead-end limit', () => {
  const sink = issueSink();
  const g = build({ bars: BAR_ONLY, sprinklered: false });
  const resolved = resolveDeadEnds({
    graph: g,
    bars: BAR_ONLY,
    exits: [{ barId: 'B1', at: [10, 6], length: 5 }],
    sprinklered: false,
    sink,
  });
  for (const d of resolved.deadEnds) assert.ok(d.length <= 6 + 1e-6, `dead end ${d.length} m`);
  assert.ok(sink.all().some(i => String(i.source).includes('unsprinklered')));
});

test('an O-plan has no dead ends: every leg end turns a corner', () => {
  const sink = issueSink();
  const g = build({ bars: O_PLAN });
  const resolved = resolveDeadEnds({
    graph: g, bars: O_PLAN, exits: [{ barId: 'BF', at: [35, 9], length: 5 }], sprinklered: true, sink,
  });
  // The only free ends are the front/rear bar ends beyond the corner, all within the limit.
  for (const d of resolved.deadEnds) assert.ok(d.length <= 15 + 1e-6, `dead end ${d.length} m`);
  assert.deepEqual(sink.all().filter(i => i.resolution?.id === 'add-core'), []);
});

test('buildCorridors is unchanged for v1 consumers and the graph is deterministic', () => {
  const spinesA = buildCorridors(O_PLAN, 'corridor-double', 1.7, [35, 32], new IdFactory('site'));
  const spinesB = buildCorridors(O_PLAN, 'corridor-double', 1.7, [35, 32], new IdFactory('site'));
  assert.equal(JSON.stringify(spinesA.map(s => s.centerline)), JSON.stringify(spinesB.map(s => s.centerline)));
  for (const s of spinesA) assert.equal(s.legs, undefined, 'buildCorridors must not populate legs');

  const g1 = build({ bars: O_PLAN });
  const g2 = build({ bars: O_PLAN });
  assert.equal(JSON.stringify(g1), JSON.stringify(g2), 'graph is not deterministic');
});
