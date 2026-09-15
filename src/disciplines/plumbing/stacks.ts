/**
 * Step 2 — stacks (PLB-01 One Stack per Dwelling Column, PLB-02 Short Trap Arms,
 * PLB-03 Vent Through Roof).
 *
 * Fixtures are grouped by DWELLING, not by wet wall: a dwelling whose architecture emits three or
 * four `type: 'wet'` walls still gets ONE stack. Within a dwelling the primary wet wall is the wall
 * line carrying the most fixtures (kitchen + main bathroom back-to-back preferred) and the stack
 * sits on that line at the bathroom group's centroid — computed in world coordinates, so a
 * dwelling that occupies several storeys (townhouse, maisonette) puts its stack on ONE vertical
 * line through all of them. Additional stacks are opened only for fixtures that cannot reach the
 * primary stack inside the trap-arm limit (PLB-02). Stations that repeat within 0.3 m on other
 * storeys become one vertical stack, so stacked dwellings share a riser.
 */
import type { PipeSystemType, PlumbingStack, Vec2 } from '../../core/types.ts';
import { add, dist, projectOnSegment, round, scale, segDir, segPointAt } from '../../core/geometry.ts';
import { maxTrapArm, stackSystems, SYSTEM_NAME } from './tables.ts';
import { emitAxis, warn, bump, type PlumbState, type StackInfo, STACK_PIPE_SPACING, info } from './state.ts';
import type { PlacedFixture } from './fixtures.ts';

const ALIGN_TOL = 0.3;
/** Two stack stations closer than this are candidates for consolidation (PLB-09) */
const MERGE_RADIUS = 3.0;
const BATHROOM_FIXTURES = new Set(['wc', 'lavatory', 'shower', 'bathtub']);
const KITCHEN_FIXTURES = new Set(['kitchen-sink', 'dishwasher']);
/** Stack budget of one dwelling column (XD-01 target: a house drains into at most two stacks) */
const MAX_STACKS_PER_GROUP = 2;
/** Absolute ceiling on stations for one group, for pathological layouts */
const MAX_STACKS_HARD = 4;
/**
 * Longest INDIVIDUALLY VENTED branch drain we are willing to model back to the dwelling's stack
 * instead of opening another stack. IPC Table 1002.2 limits the UNVENTED trap arm; a vented branch
 * has no code length limit, but it lives in the floor build-up at WASTE_Z and still has to hold
 * its fall: 12 m at the 1 % minimum for Ø100 (IPC Table 704.1) drops 120 mm, which is exactly the
 * depth available. Anything beyond that is a layout problem and gets its own stack.
 */
const MAX_VENTED_BRANCH = 12.0;

interface Candidate {
  xy: Vec2;
  dir: Vec2;
  storey: string;
  wallId: string;
  fixtures: PlacedFixture[];
  secondary: boolean;
}

/**
 * Identity of the wall LINE a fixture drains into, in world coordinates, so the same wet wall on
 * several storeys (and the several wall objects that make up one line) collapse to one key.
 */
function wallLineKey(f: PlacedFixture): string {
  const d = segDir(f.wall);
  if (Math.abs(d[1]) < 1e-6) return `y:${round(f.wall.a[1], 2)}`;
  if (Math.abs(d[0]) < 1e-6) return `x:${round(f.wall.a[0], 2)}`;
  return `w:${f.wallId}`;
}

/** How good a wall line is as a dwelling's single wet wall */
function lineScore(fixtures: PlacedFixture[]): number {
  const drained = fixtures.filter(f => f.spec.wasteD > 0);
  const bath = drained.some(f => BATHROOM_FIXTURES.has(f.fixture.type));
  const kitchen = drained.some(f => KITCHEN_FIXTURES.has(f.fixture.type));
  return drained.length * 10 + (bath && kitchen ? 6 : 0) + (bath ? 3 : 0) + fixtures.length;
}

/** World-coordinate station on a wall line: on the line, at the fixture group's centroid */
function stationOnLine(key: string, fixtures: PlacedFixture[]): Vec2 {
  const drained = fixtures.filter(f => f.spec.wasteD > 0);
  const bath = drained.filter(f => BATHROOM_FIXTURES.has(f.fixture.type));
  const basis = bath.length > 0 ? bath : drained.length > 0 ? drained : fixtures;
  const mx = basis.reduce((s, f) => s + f.center[0], 0) / basis.length;
  const my = basis.reduce((s, f) => s + f.center[1], 0) / basis.length;
  const seg = fixtures[0].wall;
  if (key.startsWith('y:')) return [round(mx, 3), round(seg.a[1], 3)];
  if (key.startsWith('x:')) return [round(seg.a[0], 3), round(my, 3)];
  const pr = projectOnSegment(seg, [mx, my]);
  const p = segPointAt(seg, Math.max(0, pr.clamped));
  return [round(p[0], 3), round(p[1], 3)];
}

function stationXY(f: PlacedFixture, along: number, off: number): Vec2 {
  const d = segDir(f.wall);
  const n: Vec2 = [-d[1], d[0]];
  return add(segPointAt(f.wall, along), scale(n, off));
}

interface Station {
  xy: Vec2;
  dir: Vec2;
  wallId: string;
  secondary: boolean;
}

/**
 * Stack stations of one group of fixtures (one dwelling column, or one common-area wet wall).
 *
 * The stations are chosen ONCE for the whole group — every storey of the group reuses them, so a
 * dwelling that spans several storeys drains into one vertical line. The primary station comes
 * from the dwelling's busiest wet wall; another station is opened only when a fixture cannot reach
 * any existing one inside its trap-arm limit, and it is placed on the busiest wall line of those
 * leftovers (not at one fixture), which keeps a house at two stacks instead of four.
 */
function stationsForGroup(
  st: PlumbState,
  group: PlacedFixture[],
  seed: { xy: Vec2; dir: Vec2; wallId: string } | null,
): Candidate[] {
  const base = seed ?? seedFromFixtures(group);
  const stations: Station[] = [{ xy: base.xy, dir: base.dir, wallId: base.wallId, secondary: false }];
  const sorted = [...group].sort((a, b) =>
    a.center[0] - b.center[0] || a.center[1] - b.center[1] || a.fixture.id.localeCompare(b.fixture.id));
  const assigned = new Map<string, number>();
  let pending = sorted;

  for (let guard = 0; guard < MAX_STACKS_PER_GROUP + 2 && pending.length > 0; guard++) {
    const left: PlacedFixture[] = [];
    for (const f of pending) {
      const best = nearestStation(stations, f, limitFor(f));
      if (best >= 0) assigned.set(f.fixture.id, best); else left.push(f);
    }
    if (left.length === 0) break;

    // `pool` is what still needs a station — never the whole group, or the next station would be
    // chosen to cover fixtures the first one already reaches.
    let pool = left;

    // Budget spent: a leftover that can still reach the dwelling's stack within the vented-branch
    // bound keeps that stack and gets an individually VENTED branch drain instead of a stack of
    // its own (IPC 905/912 — the limit in Table 1002.2 is for an UNVENTED trap arm). One stack per
    // dwelling beats a slab penetration per fixture.
    if (stations.length >= MAX_STACKS_PER_GROUP) {
      const stillFar: PlacedFixture[] = [];
      for (const f of left) {
        const idx = nearestStation(stations, f, MAX_VENTED_BRANCH);
        if (idx < 0) { stillFar.push(f); continue; }
        assigned.set(f.fixture.id, idx);
        f.vented = true;
        warn(st, `vented:${f.fixture.type}`,
          `${f.fixture.type} is ${round(routedLength(f, stations[idx].xy), 2)} m from its dwelling's stack (e.g. ${f.wallId}), past the ${limitFor(f)} m unvented trap-arm limit (IPC Table 1002.2); it is routed as an individually vented branch drain rather than opening another stack (architecture should move it onto the wet wall — XD-01)`);
        bump(st, 'ventedFixtures');
      }
      if (stillFar.length === 0) break;
      if (stations.length >= MAX_STACKS_HARD) {
        for (const f of stillFar) {
          assigned.set(f.fixture.id, Math.max(0, nearestStation(stations, f, Infinity)));
          f.vented = true;
          bump(st, 'ventedFixtures');
        }
        break;
      }
      pool = stillFar;
    }

    const next = bestStationFor(pool);
    if (!next) {
      // no candidate station reaches anything (degenerate wall geometry): vent them back
      for (const f of pool) {
        assigned.set(f.fixture.id, Math.max(0, nearestStation(stations, f, Infinity)));
        f.vented = true;
        bump(st, 'ventedFixtures');
      }
      break;
    }
    stations.push(next);
    const far = pool[0];
    if (Math.abs(far.offset) <= limitFor(far)) {
      warn(st, `split:${far.fixture.type}`,
        `${far.fixture.type} was ${round(routedLength(far, stations[0].xy), 2)} m from its dwelling's stack (e.g. ${far.wallId}), over the ${limitFor(far)} m trap-arm limit (IPC Table 1002.2); a second stack was added on its own wet wall`);
    } else {
      warn(st, `chase:${far.fixture.type}`,
        `${far.fixture.type} sits ${round(Math.abs(far.offset), 2)} m off the wet wall (e.g. ${far.wallId}), beyond the ${limitFor(far)} m trap-arm limit; a local stack/chase was added at the fixture (architecture should move the fixture onto the wet wall — XD-01)`);
    }
    bump(st, 'trapArmSplits');
    pending = pool;
  }

  // one candidate per (station, storey) that actually has fixtures
  const out: Candidate[] = [];
  const byKey = new Map<string, Candidate>();
  for (const f of sorted) {
    const idx = assigned.get(f.fixture.id) ?? 0;
    const s = stations[idx];
    const key = `${idx}|${f.storey}`;
    let cand = byKey.get(key);
    if (!cand) {
      cand = { xy: s.xy, dir: s.dir, storey: f.storey, wallId: s.wallId, fixtures: [], secondary: s.secondary };
      byKey.set(key, cand);
      out.push(cand);
    }
    cand.fixtures.push(f);
    f.stackIdx = -1; // resolved after clustering
  }
  return out;
}

/**
 * The station that serves the most of `pool` inside the trap-arm limits (greedy cover, shortest
 * total branch length as the tie-break). Candidates are each wall line's fixture centroid and each
 * fixture's own station, so two stacks usually cover a whole house.
 */
function bestStationFor(pool: PlacedFixture[]): Station | null {
  const lines = new Map<string, PlacedFixture[]>();
  for (const f of pool) {
    const k = wallLineKey(f);
    const list = lines.get(k);
    if (list) list.push(f); else lines.set(k, [f]);
  }
  const cands: { xy: Vec2; dir: Vec2; wallId: string; score: number }[] = [];
  for (const k of [...lines.keys()].sort()) {
    const fs = lines.get(k)!;
    cands.push({ xy: stationOnLine(k, fs), dir: segDir(fs[0].wall), wallId: fs[0].wallId, score: lineScore(fs) });
    for (const f of fs) {
      const perpOk = Math.abs(f.offset) <= limitFor(f);
      const off = perpOk ? 0 : f.offset - Math.sign(f.offset || 1) * 0.25;
      cands.push({ xy: stationXY(f, f.along, off), dir: segDir(f.wall), wallId: f.wallId, score: lineScore(fs) });
    }
  }
  let best: Station | null = null;
  let bestCover = -1;
  let bestSum = Infinity;
  let bestScore = -Infinity;
  for (const c of cands) {
    let cover = 0;
    let sum = 0;
    for (const f of pool) {
      const l = routedLength(f, c.xy);
      if (l <= limitFor(f) + 1e-9) { cover++; sum += l; }
    }
    const better = cover > bestCover
      || (cover === bestCover && (c.score > bestScore
        || (c.score === bestScore && sum < bestSum - 1e-9)));
    if (better) {
      bestCover = cover; bestSum = sum; bestScore = c.score;
      best = { xy: [round(c.xy[0], 3), round(c.xy[1], 3)], dir: c.dir, wallId: c.wallId, secondary: true };
    }
  }
  return bestCover > 0 ? best : null;
}

/** Index of the closest station a fixture can reach within `limit`, or -1 */
function nearestStation(stations: Station[], f: PlacedFixture, limit: number): number {
  let best = -1;
  let bestLen = Infinity;
  for (let i = 0; i < stations.length; i++) {
    const l = routedLength(f, stations[i].xy);
    if (l <= limit + 1e-9 && l < bestLen) { bestLen = l; best = i; }
  }
  return best;
}

/** Fallback seed when a group has no dwelling-wide primary wall (common-area fixtures) */
function seedFromFixtures(group: PlacedFixture[]): { xy: Vec2; dir: Vec2; wallId: string } {
  const key = wallLineKey(group[0]);
  return { xy: stationOnLine(key, group), dir: segDir(group[0].wall), wallId: group[0].wallId };
}

/**
 * The dwelling's primary wet wall: the LINE carrying the most fixtures (kitchen + main bathroom
 * back-to-back preferred), and on that line the station that reaches the most of the dwelling's
 * fixtures inside their trap-arm limits.
 */
function primaryWall(group: PlacedFixture[]): { xy: Vec2; dir: Vec2; wallId: string; lines: number } {
  const lines = new Map<string, PlacedFixture[]>();
  for (const f of group) {
    const k = wallLineKey(f);
    const list = lines.get(k);
    if (list) list.push(f); else lines.set(k, [f]);
  }
  let bestKey = '';
  let bestScore = -Infinity;
  for (const k of [...lines.keys()].sort()) {
    const s = lineScore(lines.get(k)!);
    if (s > bestScore) { bestScore = s; bestKey = k; }
  }
  const chosen = lines.get(bestKey)!;
  const positions: Vec2[] = [stationOnLine(bestKey, chosen)];
  for (const f of chosen) positions.push(stationXY(f, f.along, 0));
  let bestXY = positions[0];
  let bestCover = -1;
  let bestSum = Infinity;
  for (const xy of positions) {
    let cover = 0;
    let sum = 0;
    for (const f of group) {
      const l = routedLength(f, xy);
      if (l <= limitFor(f) + 1e-9) { cover++; sum += l; }
    }
    if (cover > bestCover || (cover === bestCover && sum < bestSum - 1e-9)) {
      bestCover = cover; bestSum = sum; bestXY = xy;
    }
  }
  return {
    xy: [round(bestXY[0], 3), round(bestXY[1], 3)],
    dir: segDir(chosen[0].wall),
    wallId: chosen[0].wallId,
    lines: lines.size,
  };
}

function averageXY(cluster: Candidate[]): Vec2 {
  return [
    cluster.reduce((s, c) => s + c.xy[0], 0) / cluster.length,
    cluster.reduce((s, c) => s + c.xy[1], 0) / cluster.length,
  ];
}

function limitFor(f: PlacedFixture): number {
  return f.spec.wasteD > 0 ? maxTrapArm(f.spec.wasteD) : Infinity;
}

/**
 * Developed length of the waste branch this module would actually build from `f` to a stack at
 * `xy`: perpendicular into the fixture's own wall, then along that wall to the stack.
 * Identical to the geometry emitted in branches.ts, so the trap-arm limit is never violated.
 */
function routedLength(f: PlacedFixture, xy: Vec2): number {
  const pr = projectOnSegment(f.wall, xy);
  return Math.abs(f.offset - pr.offset) + Math.abs(f.along - pr.along);
}

/**
 * Group fixtures into stacks and emit the vertical risers.
 * Mutates `placed[i].stackIdx` to index into the returned StackInfo list (= st.stacks).
 */
export function buildStacks(st: PlumbState, placed: PlacedFixture[]): StackInfo[] {
  // 1. one station per DWELLING COLUMN (all its storeys), plus per (storey, wall) for common areas
  const dwellings = new Map<string, PlacedFixture[]>();
  const common = new Map<string, PlacedFixture[]>();
  for (const f of placed) {
    const target = f.unitId ? dwellings : common;
    const key = f.unitId ?? `${f.storey}|${f.wallId}`;
    const g = target.get(key);
    if (g) g.push(f); else target.set(key, [f]);
  }
  const candidates: Candidate[] = [];
  let multiWallDwellings = 0;
  for (const key of [...dwellings.keys()].sort()) {
    const group = dwellings.get(key)!;
    const primary = primaryWall(group);
    if (primary.lines > 1) multiWallDwellings++;
    candidates.push(...stationsForGroup(st, group, primary));
  }
  for (const key of [...common.keys()].sort()) {
    candidates.push(...stationsForGroup(st, common.get(key)!, null));
  }
  st.counts.multiWallDwellings = multiWallDwellings;

  // 2. cluster candidates vertically by XY (grid buckets keep this O(n))
  const cell = ALIGN_TOL * 2;
  const buckets = new Map<string, number[]>();
  const clusters: Candidate[][] = [];
  const bkey = (ix: number, iy: number): string => `${ix}:${iy}`;
  for (const c of candidates) {
    const ix = Math.floor(c.xy[0] / cell), iy = Math.floor(c.xy[1] / cell);
    let found = -1;
    for (let dx = -1; dx <= 1 && found < 0; dx++) {
      for (let dy = -1; dy <= 1 && found < 0; dy++) {
        for (const ci of buckets.get(bkey(ix + dx, iy + dy)) ?? []) {
          const head = clusters[ci][0];
          if (Math.hypot(head.xy[0] - c.xy[0], head.xy[1] - c.xy[1]) <= ALIGN_TOL
            && !clusters[ci].some(m => m.storey === c.storey)) { found = ci; break; }
        }
      }
    }
    if (found < 0) {
      clusters.push([c]);
      const k = bkey(ix, iy);
      const list = buckets.get(k);
      if (list) list.push(clusters.length - 1); else buckets.set(k, [clusters.length - 1]);
    } else {
      clusters[found].push(c);
    }
  }

  // 2b. PLB-09: consolidate two stacks when ONE station can serve both inside the trap-arm limits
  //     (wet rooms that back onto each other across a party or wet wall share a chase).
  const dropped = new Set<number>();
  for (let j = clusters.length - 1; j >= 1; j--) {
    if (dropped.has(j)) continue;
    const cj = clusters[j];
    for (let i = 0; i < j; i++) {
      if (dropped.has(i)) continue;
      const ci = clusters[i];
      const target = averageXY(ci);
      if (dist(target, averageXY(cj)) > MERGE_RADIUS) continue;
      const storeysI = new Set(ci.map(c => c.storey));
      if (!cj.every(c => storeysI.has(c.storey))) continue;
      const movable = cj.flatMap(c => c.fixtures);
      if (!movable.every(f => routedLength(f, target) <= limitFor(f))) continue;
      if (!ci.flatMap(c => c.fixtures).every(f => routedLength(f, target) <= limitFor(f))) continue;
      for (const c of cj) {
        const into = ci.find(x => x.storey === c.storey);
        if (into) into.fixtures.push(...c.fixtures);
      }
      dropped.add(j);
      bump(st, 'stacksMerged');
      break;
    }
  }
  const kept = clusters.filter((_, i) => !dropped.has(i));
  if (dropped.size > 0) {
    st.apps.push({
      patternId: 'PLB-09',
      params: {
        stacksBeforeMerge: clusters.length,
        stacksAfterMerge: kept.length,
        mergeRadius: MERGE_RADIUS,
        rule: 'one station serves both wet walls within the IPC 1002.2 trap-arm limits',
      },
    });
  }

  // 3. StackInfo + vertical elements
  const central = st.ctx.typology.dhw === 'central-plant' || st.ctx.typology.dhw === 'heat-network';
  const order = st.buildingStoreys.map(s => s.id);
  const idxOf = new Map(order.map((id, i) => [id, i] as const));
  const groundIdx = idxOf.get(st.groundStorey) ?? 0;
  // highest above-grade storey: the vent has to reach it before it can pass through the roof
  let topAboveIdx = groundIdx;
  for (let i = 0; i < st.buildingStoreys.length; i++) {
    if (st.buildingStoreys[i].index >= 0) topAboveIdx = i;
  }
  const out: StackInfo[] = [];

  for (const cluster of kept) {
    const memberStoreys = cluster.map(c => c.storey);
    const memberIdx = memberStoreys.map(s => idxOf.get(s) ?? groundIdx);
    const lowUnit = Math.min(...memberIdx);
    const high = Math.max(...memberIdx);
    const low = Math.min(lowUnit, groundIdx);
    const xy: Vec2 = [
      cluster.reduce((s, c) => s + c.xy[0], 0) / cluster.length,
      cluster.reduce((s, c) => s + c.xy[1], 0) / cluster.length,
    ];
    const dir = cluster[0].dir;
    const fixtures = cluster.flatMap(c => c.fixtures);
    const systems = stackSystems(st.buildingStoreys.filter(s => s.index >= 0).length, central);
    const systemXY = new Map<PipeSystemType, Vec2>();
    const diameters = new Map<PipeSystemType, number>();
    for (let i = 0; i < systems.length; i++) {
      // The waste stack sits exactly on the station (it governs the trap arms); the smaller pipes
      // alternate either side of it, 80 mm apart inside the wet wall.
      const o = i === 0 ? 0 : (i % 2 === 1 ? 1 : -1) * Math.ceil(i / 2) * STACK_PIPE_SPACING;
      systemXY.set(systems[i].system, add(xy, scale(dir, o)));
      diameters.set(systems[i].system, systems[i].diameter);
    }
    const units = [...new Set(fixtures.map(f => f.unitId).filter((u): u is string => !!u))];
    const shaft = (st.ctx.arch?.shafts ?? []).find(s =>
      (s.purpose === 'plumbing' || s.purpose === 'combined')
      && xy[0] >= s.rect.x && xy[0] <= s.rect.x + s.rect.w
      && xy[1] >= s.rect.y && xy[1] <= s.rect.y + s.rect.h);
    const stack: PlumbingStack = {
      id: st.ids.named('STACK', String(out.length + 1).padStart(3, '0')),
      shaftId: shaft?.id,
      wetWallId: cluster[0].wallId.startsWith('VW-') ? undefined : cluster[0].wallId,
      xy: [round(xy[0]), round(xy[1])],
      systems: systems.map(s => s.system),
      fromStorey: order[low] ?? st.groundStorey,
      toStorey: st.roofStorey,
      servesUnitIds: units,
    };
    const si: StackInfo = {
      stack, dir, systemXY, diameters,
      wallIds: new Set(cluster.map(c => c.wallId)),
      storeys: order.slice(low, high + 1),
      fixtureIds: fixtures.map(f => f.fixture.id),
      dfu: fixtures.reduce((s, f) => s + f.fixture.dfu, 0),
      wsfu: fixtures.reduce((s, f) => s + f.fixture.wsfu, 0),
      secondary: cluster.every(c => c.secondary),
    };
    const myIndex = out.length;
    for (const c of cluster) for (const f of c.fixtures) f.stackIdx = myIndex;
    out.push(si);

    // vertical riser elements, one per storey per system (never spanning storeys)
    const elementIds: string[] = [];
    for (const s of si.storeys) {
      const f2f = info(st, s).f2f;
      for (const sys of systems) {
        const p = systemXY.get(sys.system)!;
        const el = emitAxis(st, {
          storey: s,
          system: sys.system,
          diameter: sys.diameter,
          a: [p[0], p[1], 0],
          b: [p[0], p[1], f2f],
          name: `${SYSTEM_NAME[sys.system]} riser Ø${Math.round(sys.diameter * 1000)}`,
          stackId: stack.id,
          patterns: ['PLB-01', 'XD-01'],
          psetExtra: [
            { name: 'DFU', value: round(si.dfu, 1) },
            { name: 'WSFU', value: round(si.wsfu, 1) },
            { name: 'ServesFixtures', value: si.fixtureIds.length },
            { name: 'Riser', value: true },
          ],
        });
        if (el) elementIds.push(el.id);
      }
    }
    // PLB-03: above the highest storey it serves, the vent alone carries on to the roof —
    // without these the vent through the roof would float, disconnected from its stack.
    const ventXY = systemXY.get('vent')!;
    const ventD = diameters.get('vent') ?? 0.075;
    for (let i = high + 1; i <= topAboveIdx; i++) {
      const s = order[i];
      if (!s) continue;
      const el = emitAxis(st, {
        storey: s,
        system: 'vent',
        diameter: ventD,
        a: [ventXY[0], ventXY[1], 0],
        b: [ventXY[0], ventXY[1], info(st, s).f2f],
        name: `Vent riser Ø${Math.round(ventD * 1000)}`,
        stackId: stack.id,
        patterns: ['PLB-03'],
        psetExtra: [{ name: 'Riser', value: true }, { name: 'VentOnly', value: true }],
      });
      if (el) elementIds.push(el.id);
    }
    const vtr = emitAxis(st, {
      storey: st.roofStorey,
      system: 'vent',
      diameter: ventD,
      a: [ventXY[0], ventXY[1], 0],
      b: [ventXY[0], ventXY[1], 0.9],
      name: `Vent through roof Ø${Math.round(ventD * 1000)}`,
      stackId: stack.id,
      patterns: ['PLB-03'],
      psetExtra: [{ name: 'Termination', value: '0.9 m above roof (IPC 904.1)' }],
    });
    if (vtr) elementIds.push(vtr.id);

    st.apps.push({
      patternId: 'PLB-01',
      storey: stack.fromStorey,
      elementIds,
      params: {
        stackId: stack.id,
        wetWallId: stack.wetWallId ?? 'virtual',
        stacksPerDwelling: round(kept.length / Math.max(1, st.ctx.arch?.units.length ?? 1), 3),
        fixturesServed: si.fixtureIds.length,
        unitsServed: units.length,
        dfu: round(si.dfu, 1),
        wsfu: round(si.wsfu, 1),
        wasteDiameter: diameters.get('waste') ?? 0.1,
        ventDiameter: ventD,
        dcwDiameter: diameters.get('dcw') ?? 0.032,
        dhwDiameter: diameters.get('dhw') ?? 0.025,
        storeys: si.storeys.length,
        secondary: si.secondary,
      },
      note: si.secondary ? 'secondary stack added for a fixture beyond the trap-arm limit (PLB-02)' : undefined,
    });
    st.apps.push({
      patternId: 'PLB-03',
      storey: st.roofStorey,
      elementIds: vtr ? [vtr.id] : [],
      params: { stackId: stack.id, ventDiameter: ventD, terminationHeight: 0.9 },
    });
    bump(st, 'stacks');
  }

  st.stacks = out;
  if (out.length === 0) warn(st, 'nostacks', 'no plumbing stacks were generated (no wet-wall fixtures found)');
  return out;
}

/** XY of one system's pipe within a stack */
export function stackXY(si: StackInfo, system: PipeSystemType): Vec2 {
  return si.systemXY.get(system) ?? (si.stack.xy as Vec2);
}
