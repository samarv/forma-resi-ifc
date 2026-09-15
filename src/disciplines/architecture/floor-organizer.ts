/**
 * The floor organiser: massing bars + cores + corridor spines → dwelling slots, corridors and
 * common rooms, then dwelling instances via the unit-layout engine.
 *
 * Two stages, deliberately separated so the typical floor can be planned once and repeated:
 *   1. `planFloorLayout` produces an ABSTRACT layout (rects + template ids, no ids, no storey).
 *      Identical (use, outline, mix, targetUnits) floors share one plan → wet walls and shafts
 *      stack automatically (ARC-08).
 *   2. `instantiateFloor` realises a plan on one storey: envelope walls, cores, corridors, units
 *      (calling `layoutUnit`), common rooms, balconies.
 */
import type {
  BalconyDef, Compass, CorridorDef, DoorDef, FurnitureDef, GenContext, Rect,
  RoomType, Side, Segment2, UnitInstance, UnitTemplateDef, UnitTemplateId, Vec2, WallDef, WindowDef,
} from '../../core/types.ts';
import type { UnitBoundaryWalls, UnitLayoutFn, UnitLayoutRequest } from './unit-layout-types.ts';
import { SIZES } from '../../core/coordination.ts';
import {
  exposureOf, insetSides, oppositeSide, polygonArea, polygonBounds, rectContainsRect, rectEdges,
  rectToPolygon, rectsOverlap, round, segDir, sideNormal, dist,
} from '../../core/geometry.ts';
import { createRng } from '../../core/rng.ts';
import { unitId as makeUnitId } from '../../core/ids.ts';
import {
  alongRange, acrossRange, apportion, ivLen, rectFromAC, sideSpan, subtractIntervals,
  type BarFrame, type Interval,
} from './bar-frame.ts';
import { ArchBuilder, railingElement, slabElement } from './arch-elements.ts';
import { buildCoreOnFloor, coreAcrossIn, coreBlockedIn, coresFor, deckRailing, type CoreLayout } from './cores.ts';
import { EnvelopeBuilder, glazeWall } from './envelope.ts';
import {
  amenityProgram, buildCommonRoom, buildParkingRamp, clusterAmenityProgram, furnishCommonRoom,
  groundProgram, programLength, retailProgram, sliceProgram, type ProgramItem,
} from './common-rooms.ts';
import type {
  CommonRoomSlot, CorridorSlot, FloorCtx, FloorLayout, SideWallSpec, UnitSlot,
} from './types-internal.ts';

export interface OrganizerDeps {
  templates: Map<UnitTemplateId, UnitTemplateDef>;
  layoutUnit: UnitLayoutFn;
}

const EXT = SIZES.exteriorWallT;
const PARTY = SIZES.partyWallT;
const CORR = SIZES.corridorWallT;

const WALL_EXT: SideWallSpec = { type: 'exterior', thickness: EXT };
const WALL_PARTY: SideWallSpec = { type: 'party', thickness: PARTY };
const WALL_CORR: SideWallSpec = { type: 'corridor', thickness: CORR };
const WALL_PART: SideWallSpec = { type: 'partition', thickness: SIZES.partitionT };
/** ARC-07: depth of a stair landing measured across the bar */
const LANDING_DEPTH = 2.6;

// ============================================================================
// Stage 1 — abstract plan
// ============================================================================

export interface PlanArgs {
  b: ArchBuilder;
  ctx: GenContext;
  f: FloorCtx;
  cores: CoreLayout[];
  deps: OrganizerDeps;
  /** number of dwellings expected in the whole building, for sizing common program */
  unitsInBuilding: number;
  hasAmenityFloor: boolean;
}

export function planFloorLayout(a: PlanArgs): FloorLayout {
  const key = planKey(a.f, a.ctx);
  const use = a.f.use;
  if (use === 'parking' || use === 'mechanical' || use === 'basement') return planServiceFloor(a, key);
  if (use === 'retail') return planRetailFloor(a, key);
  if (use === 'amenity') return planAmenityFloor(a, key);
  const access = a.ctx.typology.access;
  // 'direct' (own front door) never arrives here: houses span storeys, so the whole stack is
  // planned once by `planHouses` before the per-floor loop reaches `planFloorLayout`.
  switch (access) {
    case 'stair-core': return planStairCoreFloor(a, key);
    case 'point-core': return planPointCoreFloor(a, key);
    case 'gallery': return planCorridorFloor(a, key, 'gallery');
    case 'corridor-single': return planCorridorFloor(a, key, 'single');
    case 'cluster': return planCorridorFloor(a, key, clusterMode(a));
    default: return planCorridorFloor(a, key, 'double');
  }
}

/**
 * ARC-12: a co-living cluster wants the full depth of the bar (its own internal circulation runs
 * across it). Load the corridor on one side when the bar is deep enough for that, otherwise fall
 * back to a double-loaded plan.
 */
function clusterMode(a: PlanArgs): 'double' | 'single' {
  const t = a.deps.templates.get('coliving-cluster');
  const depth = Math.min(...a.f.bars.map(fr => fr.depth));
  const corridor = a.ctx.spec.massing.corridorWidth ?? a.ctx.typology.corridorWidth ?? 1.6;
  if (!t || !Number.isFinite(depth)) return 'double';
  return depth - corridor - EXT * 2 >= t.depth.min ? 'single' : 'double';
}

export function planKey(f: FloorCtx, ctx: GenContext): string {
  const o = polygonBounds(f.outline);
  const mix = Object.entries(f.unitMix).filter(([, v]) => (v ?? 0) > 0).map(([k, v]) => `${k}:${v}`).sort().join(',');
  return [
    f.use,
    `${round(o.x, 2)},${round(o.y, 2)},${round(o.w, 2)},${round(o.h, 2)}`,
    f.targetUnits ?? '-',
    mix,
    f.isGround ? 'G' : 'T',
    f.balconies ? 'B' : '-',
    round(f.wwr, 2),
    round(f.ceilingHeight, 2),
    ctx.typology.access,
  ].join('|');
}

function emptyLayout(key: string): FloorLayout {
  return { key, units: [], corridors: [], commons: [], blocked: {}, remnantArea: 0 };
}

// ---------------------------------------------------------------------------
// Template picking
// ---------------------------------------------------------------------------

interface Pick {
  templateId: UnitTemplateId;
  template: UnitTemplateDef;
  frontage: number;
}

interface MixPool {
  ids: UnitTemplateId[];
  weights: number[];
  templates: UnitTemplateDef[];
  cornerId: UnitTemplateId;
  corner: UnitTemplateDef;
  largest: UnitTemplateDef;
  /** the whole single-level catalogue, used only to rescue a bay the mix cannot fill */
  catalogue: UnitTemplateDef[];
}

function mixPool(a: PlanArgs): MixPool | null {
  const mix = { ...(a.ctx.typology.defaultUnitMix ?? {}), ...(a.ctx.spec.unitMix ?? {}), ...(a.f.unitMix ?? {}) };
  const ids: UnitTemplateId[] = [];
  const weights: number[] = [];
  const templates: UnitTemplateDef[] = [];
  for (const [id, w] of Object.entries(mix) as [UnitTemplateId, number | undefined][]) {
    const t = a.deps.templates.get(id);
    if (!t || !w || w <= 0) continue;
    ids.push(id);
    weights.push(w);
    templates.push(t);
  }
  if (ids.length === 0) {
    const fallback = a.deps.templates.get('1b1b') ?? [...a.deps.templates.values()][0];
    if (!fallback) return null;
    ids.push(fallback.id);
    weights.push(1);
    templates.push(fallback);
    a.b.warn(`floor ${a.f.storeyId}: unit mix empty — falling back to ${fallback.id}`);
  }
  const largest = templates.reduce((m, t) => (t.area.target > m.area.target ? t : m), templates[0]);
  const cornerIdx = ids.indexOf('corner-2b2b');
  const corner = cornerIdx >= 0 ? templates[cornerIdx] : largest;
  const catalogue = [...a.deps.templates.values()]
    .filter(t => t.storeysInUnit === 1)
    .sort((p, q) => p.frontage.min - q.frontage.min);
  return { ids, weights, templates, cornerId: corner.id, corner, largest, catalogue };
}

/**
 * The narrowest frontage a template tolerates AT THIS DEPTH. A template's `frontage.min` assumes
 * its own `depth` band; a dwelling that spans a much deeper bar (a mansion flat across the full
 * 15 m depth, say) reaches the same area on a proportionally narrower bay.
 */
function minFrontage(t: UnitTemplateDef, depth: number): number {
  const k = clamp(t.depth.max / Math.max(1, depth), 0.45, 1);
  return Math.max(2.6, round(t.frontage.min * k, 3));
}

function frontageOf(t: UnitTemplateDef, depth: number, levels = 1): number {
  const raw = t.area.target / Math.max(2, depth * levels);
  return clamp(raw, minFrontage(t, depth), t.frontage.max);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Choose templates for one strip interval, then fit their frontages to the available length.
 * Corner units (two exterior sides) take the corner template (ARC-05).
 */
function choosePicks(
  pool: MixPool, avail: number, depth: number, rng: { next(): number; weighted<T>(i: readonly T[], w: readonly number[]): T },
  cornerAtStart: boolean, cornerAtEnd: boolean, targetCount?: number,
): { picks: Pick[]; remnant: number } {
  const mk = (t: UnitTemplateDef): Pick => ({ templateId: t.id, template: t, frontage: frontageOf(t, depth) });

  // 1. how many bays fit — from the mix's weighted average frontage at this depth
  let n = targetCount;
  if (n === undefined) {
    const wTotal = pool.weights.reduce((a, c) => a + c, 0) || 1;
    const avg = pool.templates.reduce((a, t, i) => a + frontageOf(t, depth) * pool.weights[i], 0) / wTotal;
    const narrowest = Math.min(...pool.templates.map(t => minFrontage(t, depth)));
    // the absolute floor is the narrowest template in the whole catalogue, not just in the mix:
    // a bay too narrow for the mix can still be rescued by a smaller template
    const floorMin = Math.min(narrowest, ...pool.catalogue.map(t => minFrontage(t, depth)));
    n = Math.max(1, Math.round(avail / Math.max(2, avg)));
    n = Math.min(n, Math.max(1, Math.floor(avail / Math.max(1.5, narrowest))));
    if (avail < floorMin * 0.9) return { picks: [], remnant: avail };
  }
  if (n <= 0) return { picks: [], remnant: avail };

  // 2. draw templates that can take that bay width; the corner bays take the largest of them
  const per = avail / n;
  const usable = narrowPool(pool, per, depth);
  const cornerIdx = usable.ids.indexOf('corner-2b2b');
  const cornerT = cornerIdx >= 0
    ? usable.templates[cornerIdx]
    : usable.templates.reduce((m, t) => (t.area.target > m.area.target ? t : m), usable.templates[0]);
  const picks: Pick[] = [];
  for (let i = 0; i < n; i++) {
    const isCorner = (i === 0 && cornerAtStart) || (i === n - 1 && cornerAtEnd);
    picks.push(mk(isCorner ? cornerT : usable.templates[weightedIndex(usable.weights, rng.next())]));
  }
  return fitFrontages(picks, avail, usable, depth, pool.catalogue);
}

/**
 * Templates whose frontage range can take a bay `per` metres wide: the minimum must fit (with a
 * 12% tolerance, since `fitFrontages` can stretch or squeeze a bay), and the maximum should not be
 * so small that the bay has to be stretched to twice the template's width. Falls back, in order,
 * to "minimum fits" and then to the narrowest template in the mix.
 */
function narrowPool(pool: MixPool, per: number, depth: number): MixPool {
  const keep: number[] = [];
  const cap = per * 1.12 + 0.05;
  for (let i = 0; i < pool.templates.length; i++) {
    const t = pool.templates[i];
    if (minFrontage(t, depth) <= cap && t.frontage.max >= per * 0.55) keep.push(i);
  }
  if (keep.length === 0) {
    for (let i = 0; i < pool.templates.length; i++) if (minFrontage(pool.templates[i], depth) <= cap) keep.push(i);
  }
  if (keep.length === 0) {
    const narrowIdx = pool.templates.reduce(
      (m, t, i) => (minFrontage(t, depth) < minFrontage(pool.templates[m], depth) ? i : m), 0,
    );
    keep.push(narrowIdx);
  }
  return {
    ids: keep.map(i => pool.ids[i]),
    weights: keep.map(i => pool.weights[i]),
    templates: keep.map(i => pool.templates[i]),
    cornerId: pool.cornerId,
    corner: pool.corner,
    largest: pool.largest,
    catalogue: pool.catalogue,
  };
}

function weightedIndex(weights: number[], r: number): number {
  const total = weights.reduce((x, y) => x + y, 0);
  let acc = r * total;
  for (let i = 0; i < weights.length; i++) {
    acc -= weights[i];
    if (acc <= 0) return i;
  }
  return weights.length - 1;
}

/** Scale frontages onto `avail`, honouring template min/max; anything left over is the remnant. */
function fitFrontages(
  picks: Pick[], avail: number, usable?: MixPool, depth = 9, catalogue: UnitTemplateDef[] = [],
): { picks: Pick[]; remnant: number } {
  const list = [...picks];
  // If the minima do not fit, swap the widest bay for the largest template that DOES fit the
  // budget left by the other bays; only drop a bay when no substitution helps.
  let guard = 0;
  while (list.length > 0 && guard++ < list.length * 3 + 4) {
    const minTotal = list.reduce((a, p) => a + minFrontage(p.template, depth), 0);
    if (minTotal <= avail + 1e-6) break;
    let wi = 0;
    for (let i = 1; i < list.length; i++) {
      if (minFrontage(list[i].template, depth) > minFrontage(list[wi].template, depth)) wi = i;
    }
    const budget = avail - (minTotal - minFrontage(list[wi].template, depth));
    const pick = (pool: UnitTemplateDef[]): UnitTemplateDef | null => {
      const c = pool.filter(t => minFrontage(t, depth) <= budget + 1e-6);
      return c.length > 0 ? c.reduce((m, t) => (t.area.target > m.area.target ? t : m), c[0]) : null;
    };
    const best = pick(usable?.templates ?? []) ?? pick(catalogue);
    if (best && minFrontage(best, depth) < minFrontage(list[wi].template, depth) - 1e-6) {
      list[wi] = { templateId: best.id, template: best, frontage: frontageOf(best, depth) };
    } else {
      list.pop();
    }
  }
  if (list.length === 0) return { picks: [], remnant: avail };
  let total = list.reduce((a, p) => a + p.frontage, 0);
  if (total > avail) {
    // shrink toward the minima
    const slack = total - avail;
    const room = list.map(p => p.frontage - minFrontage(p.template, depth));
    const roomTotal = room.reduce((a, c) => a + c, 0);
    if (roomTotal > 0) {
      for (let i = 0; i < list.length; i++) list[i].frontage -= (slack * room[i]) / roomTotal;
    }
    total = list.reduce((a, p) => a + p.frontage, 0);
    if (total > avail + 0.01) {
      const k = avail / total;
      for (const p of list) p.frontage *= k;
      total = avail;
    }
  } else if (total < avail) {
    // ARC-02: the biggest bays absorb the leftover so the typical bay keeps its module
    let slack = avail - total;
    const order = list.map((p, i) => i).sort((p, q) => list[q].template.area.target - list[p].template.area.target);
    for (const i of order) {
      if (slack <= 0.01) break;
      const give = Math.min(slack, Math.max(0, list[i].template.frontage.max - list[i].frontage));
      list[i].frontage += give;
      slack -= give;
    }
    if (slack > 0.01) {
      const room = list.map(p => Math.max(0, p.template.frontage.max * 1.2 - p.frontage));
      const roomTotal = room.reduce((a, c) => a + c, 0);
      if (roomTotal > 0.01) {
        const give = Math.min(slack, roomTotal);
        for (let i = 0; i < list.length; i++) list[i].frontage += (give * room[i]) / roomTotal;
        slack -= give;
      }
    }
    return { picks: list.map(p => ({ ...p, frontage: round(p.frontage, 3) })), remnant: round(Math.max(0, slack), 3) };
  }
  return { picks: list.map(p => ({ ...p, frontage: round(p.frontage, 3) })), remnant: 0 };
}

// ---------------------------------------------------------------------------
// Strip packing
// ---------------------------------------------------------------------------

interface StripArgs {
  a: PlanArgs;
  frame: BarFrame;
  iv: Interval;
  cLow: number;
  cHigh: number;
  /** which side of the unit rect faces the access */
  accessSide: Side;
  /** exterior sides shared by every unit in the strip (the across face) */
  baseExterior: Side[];
  atStart: boolean;
  atEnd: boolean;
  startWall: SideWallSpec;
  endWall: SideWallSpec;
  accessWall: SideWallSpec;
  pool: MixPool;
  rng: { next(): number; weighted<T>(i: readonly T[], w: readonly number[]): T };
  targetCount?: number;
  indexRef: { n: number };
  coreId?: string;
}

function packStrip(s: StripArgs): { units: UnitSlot[]; commons: CommonRoomSlot[]; remnant: number } {
  const { frame, iv, cLow, cHigh } = s;
  const boundaryDepth = cHigh - cLow;
  // the two across-side wall specs are the same for every unit in the strip
  const acrossSpec = {} as Record<Side, SideWallSpec>;
  if (s.accessSide === frame.lowSide) {
    acrossSpec[frame.lowSide] = s.accessWall;
    acrossSpec[frame.highSide] = WALL_EXT;
  } else if (s.accessSide === frame.highSide) {
    acrossSpec[frame.highSide] = s.accessWall;
    acrossSpec[frame.lowSide] = WALL_EXT;
  } else {
    acrossSpec[frame.lowSide] = s.baseExterior.includes(frame.lowSide) ? WALL_EXT : WALL_PARTY;
    acrossSpec[frame.highSide] = s.baseExterior.includes(frame.highSide) ? WALL_EXT : WALL_PARTY;
  }
  const netDepth = boundaryDepth - acrossSpec[frame.lowSide].thickness / 2 - acrossSpec[frame.highSide].thickness / 2;
  if (netDepth < 4.0 || ivLen(iv) < 2.0) return { units: [], commons: [], remnant: ivLen(iv) };

  const cornerAtStart = s.atStart;
  const cornerAtEnd = s.atEnd;
  const { picks, remnant } = choosePicks(s.pool, ivLen(iv), netDepth, s.rng, cornerAtStart, cornerAtEnd, s.targetCount);
  const units: UnitSlot[] = [];
  const commons: CommonRoomSlot[] = [];
  let cursor = iv.s;
  for (let k = 0; k < picks.length; k++) {
    const p = picks[k];
    const a0 = cursor;
    const a1 = k === picks.length - 1 && remnant <= 0.001 ? iv.e : cursor + p.frontage;
    cursor = a1;
    const boundary = rectFromAC(frame, a0, a1, cLow, cHigh);
    const first = k === 0;
    const last = k === picks.length - 1;
    const sides = {} as Record<Side, SideWallSpec>;
    sides[frame.lowSide] = acrossSpec[frame.lowSide];
    sides[frame.highSide] = acrossSpec[frame.highSide];
    sides[frame.startSide] = first ? (s.atStart ? WALL_EXT : s.startWall) : WALL_PARTY;
    sides[frame.endSide] = last ? (s.atEnd ? WALL_EXT : s.endWall) : WALL_PARTY;
    if (s.accessSide === frame.startSide || s.accessSide === frame.endSide) sides[s.accessSide] = s.accessWall;

    const exteriorSides = [...s.baseExterior];
    if (first && s.atStart) exteriorSides.push(frame.startSide);
    if (last && s.atEnd) exteriorSides.push(frame.endSide);

    const alongLen = a1 - a0;
    const minF = minFrontage(p.template, netDepth);
    if (alongLen < minF - 0.05) {
      s.a.b.warn(`unit ${p.templateId} on ${s.a.f.storeyId} has ${round(alongLen, 2)} m frontage, below the ${round(minF, 2)} m minimum for that template at ${round(netDepth, 2)} m depth`);
    }
    units.push({
      index: s.indexRef.n++,
      templateId: p.templateId,
      boundary,
      accessSide: s.accessSide,
      exteriorSides,
      sides,
      barId: frame.barId,
      coreId: s.coreId,
      // a fixed offset from the wet-wall start: identical slot rects on every storey make
      // this the same distance on every floor, so the plumbing stacks align (XD-01)
      stackAlong: round(Math.min(1.6, alongLen * 0.3), 3),
    });
  }
  if (remnant > 0.01) {
    if (remnant <= 1.6 && units.length > 0) {
      // widen the last unit rather than leave a sliver
      const u = units[units.length - 1];
      const r = alongRange(frame, u.boundary);
      u.boundary = rectFromAC(frame, r.s, iv.e, cLow, cHigh);
      if (u.sides[frame.endSide].type === 'party' && s.atEnd) u.sides[frame.endSide] = WALL_EXT;
      return { units, commons, remnant: 0 };
    }
    const ext: Side[] = [...s.baseExterior];
    if (s.atEnd) ext.push(frame.endSide);
    commons.push({
      rect: rectFromAC(frame, iv.e - remnant, iv.e, cLow, cHigh),
      type: remnant >= 3.0 ? 'flex' : 'storage',
      name: remnant >= 3.0 ? 'Flexible Room' : 'Store',
      exteriorSides: ext,
      accessSide: s.accessSide,
      sides: { [s.accessSide]: s.accessWall } as Partial<Record<Side, SideWallSpec>>,
    });
    s.a.b.warn(`floor ${s.a.f.storeyId}: ${round(remnant, 2)} m of frontage left over on bar ${frame.barId} — placed as a ${remnant >= 3 ? 'flex room' : 'store'}`);
  }
  return { units, commons, remnant };
}

// ---------------------------------------------------------------------------
// Corridor / gallery floors
// ---------------------------------------------------------------------------

function spinesFor(a: PlanArgs, frame: BarFrame): { across: number; width: number; along: Interval; loaded: 'both' | 'left' | 'right'; id: string; dir: Vec2 } | null {
  const spines = a.ctx.site.massing.corridors.filter(c => c.barId === frame.barId);
  if (spines.length === 0) {
    const width = a.ctx.spec.massing.corridorWidth ?? a.ctx.typology.corridorWidth ?? 1.6;
    return {
      across: (frame.c0 + frame.c1) / 2, width,
      along: { s: frame.a0 + EXT / 2, e: frame.a1 - EXT / 2 },
      loaded: 'both', id: `${frame.barId}-SPINE-SYN`, dir: frame.axis === 'x' ? [1, 0] : [0, 1],
    };
  }
  const s = spines[0];
  const ivs = spines.map(sp => {
    const p = frame.axis === 'x' ? [sp.centerline.a[0], sp.centerline.b[0]] : [sp.centerline.a[1], sp.centerline.b[1]];
    return { s: Math.min(p[0], p[1]), e: Math.max(p[0], p[1]) };
  });
  const along = { s: Math.min(...ivs.map(i => i.s)), e: Math.max(...ivs.map(i => i.e)) };
  const across = frame.axis === 'x'
    ? (s.centerline.a[1] + s.centerline.b[1]) / 2
    : (s.centerline.a[0] + s.centerline.b[0]) / 2;
  return { across, width: s.width, along, loaded: s.loaded, id: s.id, dir: segDir(s.centerline) };
}

function planCorridorFloor(a: PlanArgs, key: string, mode: 'double' | 'single' | 'gallery'): FloorLayout {
  const layout = emptyLayout(key);
  const pool = mixPool(a);
  if (!pool) return layout;
  const rng = createRng(`${a.ctx.spec.seed}:${key}`);
  const indexRef = { n: 0 };
  const isCluster = a.ctx.typology.access === 'cluster';

  for (const frame of a.f.bars) {
    const spine = spinesFor(a, frame);
    if (!spine) continue;
    const eStart = frame.a0 + EXT / 2;
    const eEnd = frame.a1 - EXT / 2;
    const eLow = frame.c0 + EXT / 2;
    const eHigh = frame.c1 - EXT / 2;
    const width = Math.max(1.2, spine.width);
    const barCores = coresFor(a.cores, frame);
    layout.blocked[frame.barId] = barCores.map(c => coreBlockedIn(c, frame));

    const strips: {
      cLow: number; cHigh: number; accessSide: Side; baseExterior: Side[]; accessWall: SideWallSpec;
    }[] = [];
    let corridorAcross: Interval;
    let corridorExternal = false;
    let deckSide: Side | null = null;

    if (mode === 'gallery') {
      const nearLow = Math.abs(spine.across - frame.c0) <= Math.abs(spine.across - frame.c1);
      deckSide = nearLow ? frame.lowSide : frame.highSide;
      corridorExternal = true;
      corridorAcross = nearLow ? { s: frame.c0 - width, e: frame.c0 } : { s: frame.c1, e: frame.c1 + width };
      strips.push({
        cLow: eLow, cHigh: eHigh, accessSide: deckSide,
        baseExterior: [frame.lowSide, frame.highSide], accessWall: WALL_EXT,
      });
    } else if (mode === 'single') {
      const nearLow = Math.abs(spine.across - frame.c0) <= Math.abs(spine.across - frame.c1);
      if (nearLow) {
        corridorAcross = { s: frame.c0 + EXT, e: frame.c0 + EXT + width };
        strips.push({
          cLow: corridorAcross.e + CORR / 2, cHigh: eHigh, accessSide: frame.lowSide,
          baseExterior: [frame.highSide], accessWall: WALL_CORR,
        });
      } else {
        corridorAcross = { s: frame.c1 - EXT - width, e: frame.c1 - EXT };
        strips.push({
          cLow: eLow, cHigh: corridorAcross.s - CORR / 2, accessSide: frame.highSide,
          baseExterior: [frame.lowSide], accessWall: WALL_CORR,
        });
      }
    } else {
      const c = clamp(spine.across, frame.c0 + width / 2 + 5, frame.c1 - width / 2 - 5);
      corridorAcross = { s: c - width / 2, e: c + width / 2 };
      const leftIsHigh = (frame.axis === 'x' ? spine.dir[0] : -spine.dir[1]) > 0;
      const wantLow = spine.loaded === 'both' || (spine.loaded === 'left') === !leftIsHigh;
      const wantHigh = spine.loaded === 'both' || (spine.loaded === 'left') === leftIsHigh;
      if (wantLow) {
        strips.push({
          cLow: eLow, cHigh: corridorAcross.s - CORR / 2, accessSide: frame.highSide,
          baseExterior: [frame.lowSide], accessWall: WALL_CORR,
        });
      }
      if (wantHigh) {
        strips.push({
          cLow: corridorAcross.e + CORR / 2, cHigh: eHigh, accessSide: frame.lowSide,
          baseExterior: [frame.highSide], accessWall: WALL_CORR,
        });
      }
    }

    // ---- corridor segments (skip core blocks that sit on the corridor line) ----
    const corridorBlocks = barCores
      .filter(c => {
        const ca = acrossRange(frame, c.rect);
        return ca.s < corridorAcross.e - 0.05 && corridorAcross.s < ca.e - 0.05;
      })
      .map(c => coreBlockedIn(c, frame));
    const corridorSpan: Interval = {
      s: Math.max(eStart, Math.min(spine.along.s, eStart + 2)),
      e: Math.min(eEnd, Math.max(spine.along.e, eEnd - 2)),
    };
    for (const seg of subtractIntervals(corridorSpan, corridorBlocks, 1.2)) {
      const rect = rectFromAC(frame, seg.s, seg.e, corridorAcross.s, corridorAcross.e);
      const daylit: Side[] = [];
      if (seg.s <= eStart + 0.3) daylit.push(frame.startSide);
      if (seg.e >= eEnd - 0.3) daylit.push(frame.endSide);
      layout.corridors.push({
        rect, barId: frame.barId, spineId: spine.id, width,
        wallSides: corridorExternal ? [] : strips.map(st => oppositeSide(st.accessSide)),
        external: corridorExternal, daylitEnds: daylit,
        outerSide: deckSide ?? undefined,
      });
    }

    // ---- ground-floor common program -----------------------------------------
    const reserved: Record<number, Interval[]> = {};
    if (a.f.use === 'lobby-residential' || (a.f.isGround && a.f.use === 'residential' && a.ctx.typology.access !== 'direct')) {
      const anchor = groundAnchor(a, frame);
      const streetSide = frame.axis === 'x' ? frame.lowSide : frame.startSide;
      const prog = groundProgram({
        unitsInBuilding: a.unitsInBuilding, bikeRatio: a.ctx.typology.bikeRatio,
        storeys: a.ctx.spec.massing.storeys, region: a.ctx.spec.region, typology: a.ctx.typology,
        accessSide: strips[0]?.accessSide ?? frame.lowSide, streetSide, hasAmenityFloor: a.hasAmenityFloor,
      });
      const extra = isCluster ? clusterAmenityProgram(strips[0]?.accessSide ?? frame.lowSide) : [];
      for (let si = 0; si < strips.length; si++) {
        const st = strips[si];
        const streetward = st.baseExterior.includes(streetSide) || strips.length === 1;
        const items = streetward ? [...prog.street, ...extra] : prog.rear;
        if (items.length === 0) continue;
        const depth = st.cHigh - st.cLow - EXT / 2 - st.accessWall.thickness / 2;
        const need = Math.min(programLength(items, depth), (eEnd - eStart) * 0.55);
        const free = subtractIntervals(
          { s: eStart, e: eEnd },
          blockingCores(barCores, frame, st.cLow, st.cHigh).map(c => coreBlockedIn(c, frame)),
          1.0,
        );
        const target = pickInterval(free, anchor, need);
        if (!target) continue;
        const from: 'start' | 'end' = anchor - target.s < target.e - anchor ? 'start' : 'end';
        const ivUse: Interval = from === 'start' ? { s: target.s, e: target.s + need } : { s: target.e - need, e: target.e };
        const extSides: Partial<Record<Side, boolean>> = {};
        for (const sd of st.baseExterior) extSides[sd] = true;
        if (ivUse.s <= eStart + 0.1) extSides[frame.startSide] = true;
        if (ivUse.e >= eEnd - 0.1) extSides[frame.endSide] = true;
        const sliced = sliceProgram(frame, ivUse, st.cLow, st.cHigh, items, extSides, from);
        for (const slot of sliced.slots) {
          slot.sides = { [st.accessSide]: st.accessWall } as Partial<Record<Side, SideWallSpec>>;
          slot.accessSide = st.accessSide;
          if (slot.entrance && slot.entrance.type === 'service') slot.entrance.side = oppositeSide(st.accessSide);
        }
        layout.commons.push(...sliced.slots);
        if (sliced.used) (reserved[si] ??= []).push(sliced.used);
      }
    }

    // ---- pack the unit strips -------------------------------------------------
    const stripIntervals: { si: number; iv: Interval }[] = [];
    for (let si = 0; si < strips.length; si++) {
      const st = strips[si];
      const blocks = [
        ...blockingCores(barCores, frame, st.cLow, st.cHigh).map(c => coreBlockedIn(c, frame)),
        ...(reserved[si] ?? []),
      ];
      for (const iv of subtractIntervals({ s: eStart, e: eEnd }, blocks, 3.0)) stripIntervals.push({ si, iv });
    }
    const counts = a.f.targetUnits !== undefined
      ? apportion(a.f.targetUnits, stripIntervals.map(x => ivLen(x.iv)))
      : stripIntervals.map(() => undefined as number | undefined);

    for (let i = 0; i < stripIntervals.length; i++) {
      const { si, iv } = stripIntervals[i];
      const st = strips[si];
      const res = packStrip({
        a, frame, iv, cLow: st.cLow, cHigh: st.cHigh, accessSide: st.accessSide,
        baseExterior: [...st.baseExterior],
        atStart: iv.s <= eStart + 0.05, atEnd: iv.e >= eEnd - 0.05,
        startWall: WALL_PART, endWall: WALL_PART, accessWall: st.accessWall,
        pool, rng, targetCount: counts[i], indexRef,
        coreId: nearestCore(barCores, frame, (iv.s + iv.e) / 2)?.id,
      });
      layout.units.push(...res.units);
      layout.commons.push(...res.commons);
      layout.remnantArea += res.remnant * (st.cHigh - st.cLow);
    }
  }
  return layout;
}

/** Cores (with their shaft bay) whose across-extent intrudes into a strip */
function blockingCores(cores: CoreLayout[], frame: BarFrame, cLow: number, cHigh: number): CoreLayout[] {
  return cores.filter(c => {
    const ca = coreAcrossIn(c, frame);
    return ca.s < cHigh - 0.05 && cLow < ca.e - 0.05;
  });
}

function groundAnchor(a: PlanArgs, frame: BarFrame): number {
  const main = a.ctx.site.entrances.find(e => e.type === 'main');
  if (main) return frame.axis === 'x' ? main.position[0] : main.position[1];
  const core = coresFor(a.cores, frame)[0];
  if (core) {
    const r = alongRange(frame, core.rect);
    return (r.s + r.e) / 2;
  }
  return (frame.a0 + frame.a1) / 2;
}

function pickInterval(free: Interval[], anchor: number, need: number): Interval | null {
  const fits = free.filter(i => ivLen(i) >= need + 3.0);
  if (fits.length === 0) {
    const any = free.filter(i => ivLen(i) >= need);
    if (any.length === 0) return null;
    return any.sort((p, q) => Math.abs(mid(p) - anchor) - Math.abs(mid(q) - anchor))[0];
  }
  return fits.sort((p, q) => Math.abs(mid(p) - anchor) - Math.abs(mid(q) - anchor))[0];
}

function mid(i: Interval): number { return (i.s + i.e) / 2; }

function nearestCore(cores: CoreLayout[], frame: BarFrame, along: number): CoreLayout | undefined {
  let best: CoreLayout | undefined;
  let d = Infinity;
  for (const c of cores) {
    const r = alongRange(frame, c.rect);
    const dd = Math.abs((r.s + r.e) / 2 - along);
    if (dd < d) { d = dd; best = c; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Stair-core floors (walk-up, mansion block) — ARC-07 Two per Landing
// ---------------------------------------------------------------------------

function planStairCoreFloor(a: PlanArgs, key: string): FloorLayout {
  const layout = emptyLayout(key);
  const pool = mixPool(a);
  if (!pool) return layout;
  const rng = createRng(`${a.ctx.spec.seed}:${key}`);
  const indexRef = { n: 0 };
  const perCore = clamp(a.ctx.typology.unitsPerCore ?? 2, 2, 4);
  const acrossStrips = perCore >= 4 ? 2 : 1;

  for (const frame of a.f.bars) {
    const eStart = frame.a0 + EXT / 2;
    const eEnd = frame.a1 - EXT / 2;
    const eLow = frame.c0 + EXT / 2;
    const eHigh = frame.c1 - EXT / 2;
    const barCores = coresFor(a.cores, frame);
    if (barCores.length === 0) {
      a.b.warn(`bar ${frame.barId} has no core for a stair-core typology — no dwellings placed`);
      continue;
    }
    layout.blocked[frame.barId] = barCores.map(c => coreBlockedIn(c, frame));

    // landing per core, plus any leftover pocket beside the core
    const blocks: { core: CoreLayout; iv: Interval }[] = [];
    for (const core of barCores) {
      const ca = acrossRange(frame, core.rect);
      const cAl = alongRange(frame, core.rect);
      const lowRoom = ca.s - eLow;
      const highRoom = eHigh - ca.e;
      const cb = coreBlockedIn(core, frame);
      const iv: Interval = { s: Math.min(cb.s, cAl.s), e: Math.max(cb.e, cAl.e) };
      if (Math.max(lowRoom, highRoom) >= 2.0) {
        const useLow = lowRoom >= highRoom;
        const room = useLow ? lowRoom : highRoom;
        const landingDepth = Math.min(room, LANDING_DEPTH);
        const l0 = useLow ? ca.s - landingDepth : ca.e;
        const l1 = l0 + landingDepth;
        layout.commons.push({
          rect: rectFromAC(frame, cAl.s, cAl.e, l0, l1), type: 'lobby', name: 'Stair Landing',
          exteriorSides: room - landingDepth < 0.35 ? [useLow ? frame.lowSide : frame.highSide] : [],
          accessSide: undefined, open: false,
          sides: { [useLow ? frame.highSide : frame.lowSide]: { type: 'core', thickness: SIZES.coreWallT } } as Partial<Record<Side, SideWallSpec>>,
        });
        // pocket beyond the landing, and the shallow side, become resident storage
        const pockets: { c0: number; c1: number; ext: Side }[] = [];
        if (room - landingDepth >= 1.6) {
          pockets.push(useLow
            ? { c0: eLow, c1: l0, ext: frame.lowSide }
            : { c0: l1, c1: eHigh, ext: frame.highSide });
        }
        const other = useLow ? highRoom : lowRoom;
        if (other >= 1.6) {
          pockets.push(useLow
            ? { c0: ca.e, c1: eHigh, ext: frame.highSide }
            : { c0: eLow, c1: ca.s, ext: frame.lowSide });
        }
        for (const pk of pockets) {
          layout.commons.push({
            rect: rectFromAC(frame, cAl.s, cAl.e, pk.c0, pk.c1),
            type: 'storage', name: 'Resident Storage', exteriorSides: [pk.ext], open: false,
          });
        }
      } else {
        // no depth for a landing across the bar: take 2.4 m along the bar instead
        const toCentre = cAl.s - frame.a0 < frame.a1 - cAl.e ? 1 : -1;
        const l0 = toCentre > 0 ? cAl.e : cAl.s - LANDING_DEPTH;
        layout.commons.push({
          rect: rectFromAC(frame, l0, l0 + LANDING_DEPTH, eLow, eHigh), type: 'lobby', name: 'Stair Landing',
          exteriorSides: [frame.lowSide, frame.highSide], open: false,
        });
        iv.s = Math.min(iv.s, l0);
        iv.e = Math.max(iv.e, l0 + LANDING_DEPTH);
      }
      blocks.push({ core, iv });
    }

    const free = subtractIntervals({ s: eStart, e: eEnd }, blocks.map(x => x.iv), 3.0);
    const maxFrontage = pool.largest.frontage.max;
    const minSeg = Math.min(...pool.templates.map(t => minFrontage(t, eHigh - eLow - EXT)));
    for (const iv of free) {
      const bounding = blocks.filter(x => Math.abs(x.iv.e - iv.s) < 0.3 || Math.abs(x.iv.s - iv.e) < 0.3);
      const groups = Math.max(1, Math.min(bounding.length, Math.floor(ivLen(iv) / Math.max(1, minSeg)) || 1));
      const segLen = ivLen(iv) / groups;
      for (let g = 0; g < groups; g++) {
        const gs = iv.s + g * segLen;
        const ge = gs + segLen;
        const core = bounding[g] ?? bounding[0] ?? { core: barCores[0], iv: coreBlockedIn(barCores[0], frame) };
        const towardEnd = Math.abs(core.iv.s - ge) < Math.abs(core.iv.e - gs);
        const accessSide = towardEnd ? frame.endSide : frame.startSide;
        // units take at most one template frontage; the landing absorbs the slack
        if (segLen < minSeg - 0.05) {
          a.b.warn(`bar ${frame.barId}: core spacing leaves only ${round(segLen, 2)} m per landing side — below the ${round(minSeg, 2)} m minimum for the mix; reduce massing.coreCount`);
        }
        const useLen = Math.min(segLen, maxFrontage);
        const u0 = towardEnd ? ge - useLen : gs;
        const u1 = u0 + useLen;
        if (useLen < segLen - 0.2) {
          const slackRect = towardEnd
            ? rectFromAC(frame, gs, u0, eLow, eHigh)
            : rectFromAC(frame, u1, ge, eLow, eHigh);
          layout.commons.push({
            rect: slackRect, type: 'flex', name: 'Shared Flexible Room',
            exteriorSides: [frame.lowSide, frame.highSide], open: false,
            accessSide,
          });
          a.b.warn(`bar ${frame.barId}: core spacing leaves ${round(segLen - useLen, 2)} m beyond the ${maxFrontage} m maximum frontage — placed as a shared flex room (increase massing.coreCount)`);
        }
        const bands = acrossStrips === 1
          ? [{ c0: eLow, c1: eHigh, ext: [frame.lowSide, frame.highSide] as Side[] }]
          : [
            { c0: eLow, c1: (eLow + eHigh) / 2 - SIZES.partitionT / 2, ext: [frame.lowSide] as Side[] },
            { c0: (eLow + eHigh) / 2 + SIZES.partitionT / 2, c1: eHigh, ext: [frame.highSide] as Side[] },
          ];
        for (const band of bands) {
          const res = packStrip({
            a, frame, iv: { s: u0, e: u1 }, cLow: band.c0, cHigh: band.c1,
            accessSide, baseExterior: band.ext,
            atStart: u0 <= eStart + 0.05, atEnd: u1 >= eEnd - 0.05,
            startWall: WALL_PART, endWall: WALL_PART,
            accessWall: accessSide === frame.startSide || accessSide === frame.endSide
              ? { type: 'partition', thickness: SIZES.partitionT } : WALL_CORR,
            pool, rng, targetCount: 1, indexRef, coreId: core.core.id,
          });
          for (const u of res.units) {
            u.sides[accessSide] = { type: 'partition', thickness: SIZES.partitionT };
            if (acrossStrips === 2) {
              const inner = band.ext.includes(frame.lowSide) ? frame.highSide : frame.lowSide;
              u.sides[inner] = WALL_PARTY;
            }
          }
          layout.units.push(...res.units);
          layout.commons.push(...res.commons);
        }
      }
    }
  }
  return layout;
}

// ---------------------------------------------------------------------------
// Point-core floors
// ---------------------------------------------------------------------------

function planPointCoreFloor(a: PlanArgs, key: string): FloorLayout {
  const layout = emptyLayout(key);
  const pool = mixPool(a);
  if (!pool) return layout;
  const rng = createRng(`${a.ctx.spec.seed}:${key}`);
  const indexRef = { n: 0 };
  const ring = 1.6;

  for (const frame of a.f.bars) {
    const core = coresFor(a.cores, frame)[0] ?? a.cores[0];
    if (!core) {
      a.b.warn(`point-core floor ${a.f.storeyId} has no core — no dwellings placed`);
      continue;
    }
    layout.blocked[frame.barId] = [coreBlockedIn(core, frame)];
    const plate: Rect = { x: frame.axis === 'x' ? frame.a0 : frame.c0, y: frame.axis === 'x' ? frame.c0 : frame.a0, w: frame.axis === 'x' ? frame.length : frame.depth, h: frame.axis === 'x' ? frame.depth : frame.length };
    const outer = insetSides(plate, { front: EXT / 2, rear: EXT / 2, left: EXT / 2, right: EXT / 2 });
    // the ring wraps the core AND its shaft bay, so nothing pokes into a dwelling
    const zone = core.shaftBlock ? unionOf(core.rect, core.shaftBlock) : core.rect;
    const ringOuter: Rect = {
      x: round(zone.x - ring), y: round(zone.y - ring),
      w: round(zone.w + 2 * ring), h: round(zone.h + 2 * ring),
    };
    // the lift-lobby ring, as four bands so it is a donut and never covers the core itself
    const ringBands: Rect[] = [
      { x: ringOuter.x, y: ringOuter.y, w: ringOuter.w, h: round(zone.y - ringOuter.y) },
      { x: ringOuter.x, y: round(zone.y + zone.h), w: ringOuter.w, h: round(ringOuter.y + ringOuter.h - (zone.y + zone.h)) },
      { x: ringOuter.x, y: zone.y, w: round(zone.x - ringOuter.x), h: zone.h },
      { x: round(zone.x + zone.w), y: zone.y, w: round(ringOuter.x + ringOuter.w - (zone.x + zone.w)), h: zone.h },
    ].filter(r => r.w > 0.4 && r.h > 0.4);
    for (const rb of ringBands) {
      layout.corridors.push({
        rect: rb, barId: frame.barId, spineId: `${frame.barId}-RING`, width: ring,
        wallSides: [], external: false, daylitEnds: [],
      });
    }

    const allBands: { rect: Rect; accessSide: Side; ext: Side[]; along: 'x' | 'y' }[] = [
      { rect: { x: outer.x, y: outer.y, w: outer.w, h: Math.max(0, ringOuter.y - CORR / 2 - outer.y) }, accessSide: 'rear', ext: ['front'], along: 'x' },
      { rect: { x: outer.x, y: ringOuter.y + ringOuter.h + CORR / 2, w: outer.w, h: Math.max(0, outer.y + outer.h - (ringOuter.y + ringOuter.h + CORR / 2)) }, accessSide: 'front', ext: ['rear'], along: 'x' },
      { rect: { x: outer.x, y: ringOuter.y, w: Math.max(0, ringOuter.x - CORR / 2 - outer.x), h: ringOuter.h }, accessSide: 'right', ext: ['left'], along: 'y' },
      { rect: { x: ringOuter.x + ringOuter.w + CORR / 2, y: ringOuter.y, w: Math.max(0, outer.x + outer.w - (ringOuter.x + ringOuter.w + CORR / 2)), h: ringOuter.h }, accessSide: 'left', ext: ['right'], along: 'y' },
    ];
    const bands = allBands.filter(b => b.rect.w > 3 && b.rect.h > 3);
    if (bands.length === 0) {
      a.b.warn(`point-core floor ${a.f.storeyId}: core ${core.id} leaves no room for dwellings`);
      continue;
    }

    const want = clamp(a.f.targetUnits ?? a.ctx.typology.unitsPerCore ?? 6, Math.max(4, bands.length), 8);
    const lens = bands.map(b => (b.along === 'x' ? b.rect.w : b.rect.h));
    const counts = apportion(want, lens);
    for (let i = 0; i < bands.length; i++) if (counts[i] === 0) counts[i] = 1;

    for (let i = 0; i < bands.length; i++) {
      const band = bands[i];
      const bf: BarFrame = {
        barId: frame.barId, axis: band.along,
        a0: band.along === 'x' ? band.rect.x : band.rect.y,
        a1: band.along === 'x' ? band.rect.x + band.rect.w : band.rect.y + band.rect.h,
        c0: band.along === 'x' ? band.rect.y : band.rect.x,
        c1: band.along === 'x' ? band.rect.y + band.rect.h : band.rect.x + band.rect.w,
        lowSide: band.along === 'x' ? 'front' : 'left',
        highSide: band.along === 'x' ? 'rear' : 'right',
        startSide: band.along === 'x' ? 'left' : 'front',
        endSide: band.along === 'x' ? 'right' : 'rear',
        length: band.along === 'x' ? band.rect.w : band.rect.h,
        depth: band.along === 'x' ? band.rect.h : band.rect.w,
        exteriorSides: band.ext,
      };
      const atStart = band.along === 'x' ? band.rect.x <= outer.x + 0.05 : band.rect.y <= outer.y + 0.05;
      const atEnd = band.along === 'x' ? band.rect.x + band.rect.w >= outer.x + outer.w - 0.05 : band.rect.y + band.rect.h >= outer.y + outer.h - 0.05;
      const res = packStrip({
        a, frame: bf, iv: { s: bf.a0, e: bf.a1 }, cLow: bf.c0, cHigh: bf.c1,
        accessSide: band.accessSide, baseExterior: [...band.ext],
        atStart, atEnd, startWall: WALL_PARTY, endWall: WALL_PARTY, accessWall: WALL_CORR,
        pool, rng, targetCount: counts[i], indexRef, coreId: core.id,
      });
      layout.units.push(...res.units);
      layout.commons.push(...res.commons);
    }
  }
  return layout;
}

// ---------------------------------------------------------------------------
// Direct access (houses) — ARC-01 / ARC-02 / ARC-10 / ARC-11
// ---------------------------------------------------------------------------

export function planHouses(a: PlanArgs, residentialStoreys: string[]): FloorLayout {
  const key = `houses|${a.ctx.typology.id}|${residentialStoreys.join(',')}`;
  const layout = emptyLayout(key);
  const pool = mixPool(a);
  if (!pool) return layout;
  const indexRef = { n: 0 };
  const stacked = a.ctx.typology.id === 'stacked-townhouse';
  const levels = stacked ? Math.max(1, residentialStoreys.length - 1) : residentialStoreys.length;

  for (const frame of a.f.bars) {
    const eStart = frame.a0 + EXT / 2;
    const eEnd = frame.a1 - EXT / 2;
    const eLow = frame.c0 + EXT / 2;
    const eHigh = frame.c1 - EXT / 2;
    const entrySide: Side = frame.axis === 'x' ? 'front' : 'left';
    const depthNet = eHigh - eLow - EXT;
    const template = pool.templates.reduce((m, t) => (t.area.target > m.area.target ? t : m), pool.templates[0]);

    let n: number;
    switch (a.ctx.typology.id) {
      case 'detached-house':
      case 'adu-laneway': n = 1; break;
      case 'semi-detached': n = 2; break;
      default: {
        const target = frontageOf(template, depthNet, levels);
        const len = eEnd - eStart;
        n = Math.max(1, Math.round(len / target));
        const minF = minFrontage(template, depthNet);
        if (len / n < minF - 0.05) n = Math.max(1, Math.floor(len / minF));
        break;
      }
    }
    const frontage = (eEnd - eStart) / n;
    if (frontage < minFrontage(template, depthNet) - 0.05) {
      a.b.warn(`house frontage ${round(frontage, 2)} m is below the ${round(minFrontage(template, depthNet), 2)} m minimum for ${template.id}`);
    }
    const unitEntrances = a.ctx.site.entrances
      .filter(e => e.type === 'unit')
      .map(e => (frame.axis === 'x' ? e.position[0] : e.position[1]))
      .sort((p, q) => p - q);
    const garageEntrances = a.ctx.site.entrances
      .filter(e => e.type === 'garage')
      .map(e => (frame.axis === 'x' ? e.position[0] : e.position[1]))
      .sort((p, q) => p - q);

    for (let k = 0; k < n; k++) {
      const a0 = eStart + k * frontage;
      const a1 = a0 + frontage;
      const first = k === 0;
      const last = k === n - 1;
      const stairStrip = stacked ? Math.min(1.5, frontage * 0.22) : 0;
      const groundA1 = a1 - stairStrip;

      const sides = {} as Record<Side, SideWallSpec>;
      sides[frame.lowSide] = WALL_EXT;
      sides[frame.highSide] = WALL_EXT;
      sides[frame.startSide] = first ? WALL_EXT : WALL_PARTY;
      sides[frame.endSide] = last ? WALL_EXT : WALL_PARTY;
      const exteriorSides: Side[] = [frame.lowSide, frame.highSide];
      if (first) exteriorSides.push(frame.startSide);
      if (last) exteriorSides.push(frame.endSide);

      const wantGarage = template.id === 'townhouse-3s' || template.rooms.some(r => r.type === 'garage');
      const doorAt = unitEntrances[k] !== undefined ? unitEntrances[k] - a0 : undefined;
      const stairRect = houseStairRect(frame, a0, groundA1, eLow, eHigh, entrySide);

      if (stacked) {
        // ground dwelling + maisonette above, each with its own street door
        layout.units.push({
          index: indexRef.n++, templateId: pickHouseTemplate(pool, false), boundary: rectFromAC(frame, a0, groundA1, eLow, eHigh),
          accessSide: entrySide, exteriorSides: exteriorSides.filter(s => s !== frame.endSide || last), sides,
          barId: frame.barId, stackAlong: round(Math.min(1.4, frontage * 0.25), 3),
          storeySpan: [residentialStoreys[0]],
          extraDoors: doorAt !== undefined ? [] : [],
          notes: 'ground flat',
        });
        // private stair to the upper dwelling
        layout.commons.push({
          rect: rectFromAC(frame, groundA1, a1, eLow, eLow + Math.min(5.0, eHigh - eLow)),
          type: 'stair', name: 'Private Stair to Upper Flat',
          exteriorSides: [frame.lowSide, ...(last ? [frame.endSide] : [])],
          entrance: { side: entrySide, width: SIZES.doorUnitEntry, type: 'building-entry' },
          sides: { [frame.highSide]: WALL_PART } as Partial<Record<Side, SideWallSpec>>,
        });
        if (eHigh - (eLow + Math.min(5.0, eHigh - eLow)) > 1.8) {
          layout.commons.push({
            rect: rectFromAC(frame, groundA1, a1, eLow + Math.min(5.0, eHigh - eLow), eHigh),
            type: 'storage', name: 'Garden Store',
            exteriorSides: [frame.highSide, ...(last ? [frame.endSide] : [])],
          });
        }
        const upperSides = { ...sides };
        layout.units.push({
          index: indexRef.n++, templateId: pickHouseTemplate(pool, true), boundary: rectFromAC(frame, a0, a1, eLow, eHigh),
          accessSide: entrySide, exteriorSides, sides: upperSides, barId: frame.barId,
          stackAlong: round(Math.min(1.4, frontage * 0.25), 3),
          storeySpan: residentialStoreys.slice(1),
          stairRect: houseStairRect(frame, a0, a1, eLow, eHigh, entrySide),
          notes: 'maisonette over',
        });
      } else {
        layout.units.push({
          index: indexRef.n++, templateId: template.id, boundary: rectFromAC(frame, a0, a1, eLow, eHigh),
          accessSide: entrySide, exteriorSides, sides, barId: frame.barId,
          stackAlong: round(Math.min(1.4, frontage * 0.25), 3),
          storeySpan: residentialStoreys,
          stairRect: residentialStoreys.length > 1 ? stairRect : undefined,
          extraDoors: wantGarage
            ? [{
              side: entrySide, width: 2.6, height: 2.2, type: 'garage',
              offset: garageEntrances[k] !== undefined ? garageEntrances[k] - a0 : (last ? frontage - 1.6 : 1.6),
            }]
            : undefined,
        });
      }
      void doorAt;
    }
  }
  return layout;
}

function unionOf(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

function pickHouseTemplate(pool: MixPool, upper: boolean): UnitTemplateId {
  const maison = pool.templates.find(t => t.storeysInUnit > 1);
  const flat = pool.templates.find(t => t.storeysInUnit === 1);
  if (upper) return (maison ?? pool.largest).id;
  return (flat ?? pool.templates[0]).id;
}

function houseStairRect(frame: BarFrame, a0: number, a1: number, c0: number, c1: number, entrySide: Side): Rect {
  const runLen = Math.min(4.0, (c1 - c0) * 0.42);
  const w = 1.0;
  const alongPos = a0 + 0.25;
  const fromEntry = 1.6;
  const acrossPos = entrySide === frame.lowSide ? c0 + fromEntry : c1 - fromEntry - runLen;
  return rectFromAC(frame, alongPos, Math.min(alongPos + w, a1 - 0.2), acrossPos, acrossPos + runLen);
}

// ---------------------------------------------------------------------------
// Service floors: parking, retail, amenity, mechanical
// ---------------------------------------------------------------------------

function fullDepthFree(a: PlanArgs, frame: BarFrame): Interval[] {
  const barCores = coresFor(a.cores, frame);
  return subtractIntervals(
    { s: frame.a0 + EXT / 2, e: frame.a1 - EXT / 2 },
    barCores.map(c => coreBlockedIn(c, frame)), 2.0,
  );
}

function planServiceFloor(a: PlanArgs, key: string): FloorLayout {
  const layout = emptyLayout(key);
  for (const frame of a.f.bars) {
    const eLow = frame.c0 + EXT / 2;
    const eHigh = frame.c1 - EXT / 2;
    layout.blocked[frame.barId] = coresFor(a.cores, frame).map(c => coreBlockedIn(c, frame));
    const free = fullDepthFree(a, frame);
    for (let i = 0; i < free.length; i++) {
      const iv = free[i];
      const ext: Side[] = [frame.lowSide, frame.highSide];
      if (iv.s <= frame.a0 + EXT) ext.push(frame.startSide);
      if (iv.e >= frame.a1 - EXT) ext.push(frame.endSide);
      const type: RoomType = a.f.use === 'mechanical' ? 'plant' : a.f.use === 'basement' ? 'basement' : 'parking';
      layout.commons.push({
        rect: rectFromAC(frame, iv.s, iv.e, eLow, eHigh),
        type,
        name: type === 'parking' ? `Parking Deck ${i + 1}` : undefined,
        exteriorSides: ext,
        open: true,
        glazing: { sill: 1.2, height: 0.8, wwr: 0.06 },
      });
    }
  }
  return layout;
}

function planRetailFloor(a: PlanArgs, key: string): FloorLayout {
  const layout = emptyLayout(key);
  for (const frame of a.f.bars) {
    const eStart = frame.a0 + EXT / 2;
    const eEnd = frame.a1 - EXT / 2;
    const eLow = frame.c0 + EXT / 2;
    const eHigh = frame.c1 - EXT / 2;
    const barCores = coresFor(a.cores, frame);
    layout.blocked[frame.barId] = barCores.map(c => coreBlockedIn(c, frame));
    const streetSide = frame.axis === 'x' ? frame.lowSide : frame.startSide;
    const anchor = groundAnchor(a, frame);
    const free = fullDepthFree(a, frame);
    const depth = eHigh - eLow;
    const retailDepth = Math.min(depth, Math.max(9, depth * 0.62));
    const bohC0 = eLow + retailDepth + CORR / 2;

    for (const iv of free) {
      const ext: Side[] = [frame.lowSide];
      if (iv.s <= eStart + 0.1) ext.push(frame.startSide);
      if (iv.e >= eEnd - 0.1) ext.push(frame.endSide);
      const retailC1 = Math.min(eHigh, eLow + retailDepth);
      const nearAnchor = Math.abs(mid(iv) - anchor) < ivLen(iv) / 2 + 6;
      const items: ProgramItem[] = [];
      if (nearAnchor) {
        items.push({
          type: 'lobby', name: 'Residential Lobby', area: 45, minLen: 5.0,
          entrance: { side: streetSide, width: SIZES.doorBuildingEntry, type: 'building-entry' },
        });
      }
      items.push(...retailProgram(ivLen(iv), retailC1 - eLow, streetSide, frame.highSide));
      const extMap: Partial<Record<Side, boolean>> = { [frame.lowSide]: true };
      if (iv.s <= eStart + 0.1) extMap[frame.startSide] = true;
      if (iv.e >= eEnd - 0.1) extMap[frame.endSide] = true;
      const sliced = sliceProgram(frame, iv, eLow, retailC1, items, extMap, 'start');
      layout.commons.push(...sliced.slots);
      if (bohC0 < eHigh - 2.0) {
        const boh: ProgramItem[] = [
          { type: 'trash', name: 'Refuse & Recycling', area: 18, minLen: 3.0 },
          { type: 'mech-room', name: 'Mechanical Room', area: 22, minLen: 3.5 },
          { type: 'elec-room', name: 'Electrical Switch Room', area: 14, minLen: 3.0 },
          { type: 'bike-store', name: 'Bicycle Store', area: 40, minLen: 4.0 },
          { type: 'storage', name: 'Retail Store', area: 60, minLen: 4.0 },
        ];
        const rearExt: Partial<Record<Side, boolean>> = { [frame.highSide]: true };
        if (iv.s <= eStart + 0.1) rearExt[frame.startSide] = true;
        if (iv.e >= eEnd - 0.1) rearExt[frame.endSide] = true;
        const rear = sliceProgram(frame, iv, bohC0, eHigh, boh, rearExt, 'start');
        layout.commons.push(...rear.slots);
      }
      void ext;
    }
  }
  return layout;
}

function planAmenityFloor(a: PlanArgs, key: string): FloorLayout {
  const layout = emptyLayout(key);
  for (const frame of a.f.bars) {
    const eLow = frame.c0 + EXT / 2;
    const eHigh = frame.c1 - EXT / 2;
    layout.blocked[frame.barId] = coresFor(a.cores, frame).map(c => coreBlockedIn(c, frame));
    for (const iv of fullDepthFree(a, frame)) {
      const items = amenityProgram(ivLen(iv) * (eHigh - eLow), frame.highSide);
      const extMap: Partial<Record<Side, boolean>> = { [frame.lowSide]: true, [frame.highSide]: true };
      if (iv.s <= frame.a0 + EXT) extMap[frame.startSide] = true;
      if (iv.e >= frame.a1 - EXT) extMap[frame.endSide] = true;
      const sliced = sliceProgram(frame, iv, eLow, eHigh, items, extMap, 'start');
      layout.commons.push(...sliced.slots);
    }
  }
  return layout;
}

// ============================================================================
// Stage 2 — instantiate a plan on one storey
// ============================================================================

export interface InstantiateArgs {
  b: ArchBuilder;
  ctx: GenContext;
  f: FloorCtx;
  layout: FloorLayout;
  cores: CoreLayout[];
  deps: OrganizerDeps;
  /** unit instances keyed by slot key, for multi-storey dwellings */
  unitRegistry: Map<string, UnitInstance>;
  emitSlabs: boolean;
}

export interface FloorResult {
  unitIds: string[];
  corridors: CorridorDef[];
  commonRoomIds: string[];
  exteriorWallArea: number;
  windowArea: number;
  corridorLength: number;
  circulationArea: number;
  coreArea: number;
}

export function instantiateFloor(args: InstantiateArgs): FloorResult {
  const { b, ctx, f, layout, cores } = args;
  const st = f.storeyId;
  const streetFacing = ctx.site.streetFacing;
  const env = new EnvelopeBuilder(f.outline, st, f.wallHeight, streetFacing);

  // ---- register every break BEFORE the envelope is cut --------------------
  for (const u of layout.units) registerBreaks(env, u.boundary, u.exteriorSides);
  for (const c of layout.commons) registerBreaks(env, c.rect, c.exteriorSides);
  for (const c of layout.corridors) if (!c.external) registerBreaks(env, c.rect, ['front', 'rear', 'left', 'right']);
  for (const c of cores) registerBreaks(env, c.rect, c.exteriorSides);
  env.build(b);

  const result: FloorResult = {
    unitIds: [], corridors: [], commonRoomIds: [], exteriorWallArea: 0, windowArea: 0,
    corridorLength: 0, circulationArea: 0, coreArea: 0,
  };

  // ---- cores --------------------------------------------------------------
  for (const c of cores) {
    if (!c.storeys.includes(st)) continue;
    buildCoreOnFloor(b, c, f, streetFacing, env);
    result.coreArea += c.rect.w * c.rect.h;
  }

  // ---- corridors ----------------------------------------------------------
  for (const cs of layout.corridors) {
    const room = b.addRoom({
      storey: st, type: 'corridor', rect: cs.rect, height: f.ceilingHeight,
      name: cs.external ? 'Access Deck' : 'Corridor',
      zone: 'circulation',
    });
    result.commonRoomIds.push(room.id);
    result.circulationArea += room.area;
    const len = Math.max(cs.rect.w, cs.rect.h);
    result.corridorLength += len;
    const centerline: Segment2[] = [cs.rect.w >= cs.rect.h
      ? { a: [cs.rect.x, cs.rect.y + cs.rect.h / 2], b: [cs.rect.x + cs.rect.w, cs.rect.y + cs.rect.h / 2] }
      : { a: [cs.rect.x + cs.rect.w / 2, cs.rect.y], b: [cs.rect.x + cs.rect.w / 2, cs.rect.y + cs.rect.h] }];
    const def: CorridorDef = {
      id: b.ids.next(st, 'CORR'), storey: st, polygon: rectToPolygon(cs.rect), centerline,
      width: cs.width, roomId: room.id,
    };
    b.corridors.push(def);
    result.corridors.push(def);

    if (cs.external) {
      deckRailing(b, st, cs.rect, cs.outerSide ?? 'front', ['ARC-09']);
      slabElement(b, st, cs.rect, 0.2, -0.2, 'FLOOR', 'Access deck slab', ['ARC-09']);
    } else {
      // daylight at the ends (ARC-03)
      for (const side of cs.daylitEnds) {
        const span = sideSpan(cs.rect, side);
        const w = env.wallFor(side, span.across, span.a0, span.a1);
        if (w) {
          result.windowArea += glazeWall(b, w, room.id, { wwr: 0.4, sill: 0.9, height: 1.8 });
          room.exteriorWallIds.push(w.id);
          room.hasExterior = true;
        }
      }
    }
  }

  // ---- units --------------------------------------------------------------
  for (const slot of layout.units) {
    const span = slot.storeySpan;
    if (span && !span.includes(st)) continue;
    const slotKey = `${layout.key}|${slot.index}`;
    const existing = span && span.length > 1 ? args.unitRegistry.get(slotKey) : undefined;
    const level = span ? Math.max(0, span.indexOf(st)) : 0;
    const inst = buildUnit(args, env, slot, level, span?.length ?? 1, existing, slotKey);
    if (inst) result.unitIds.push(inst.id);
  }

  // ---- common rooms -------------------------------------------------------
  for (const slot of layout.commons) {
    const { room, glazedArea } = buildCommonRoom(b, f, slot, env, streetFacing);
    furnishCommonRoom(b, room, ctx.spec.options.detail);
    result.commonRoomIds.push(room.id);
    result.windowArea += glazedArea;
    if (room.zone === 'circulation') result.circulationArea += room.area;
  }

  // parking ramp
  if (f.use === 'parking' && f.bars[0]) {
    buildParkingRamp(b, f, f.bars[0], coresFor(cores, f.bars[0]).map(c => coreBlockedIn(c, f.bars[0])));
  }

  // ---- exterior wall / window accounting ---------------------------------
  for (const w of env.allWalls()) result.exteriorWallArea += dist(w.start, w.end) * w.height;
  result.windowArea = b.windows.filter(w => w.storey === st).reduce((acc, w) => acc + w.width * w.height, 0);

  return result;
}

function registerBreaks(env: EnvelopeBuilder, rect: Rect, sides: Side[]): void {
  for (const side of sides) {
    const span = sideSpan(rect, side);
    env.addSpan(side, span.across, span.a0, span.a1);
  }
}

// ---------------------------------------------------------------------------
// One dwelling
// ---------------------------------------------------------------------------

function buildUnit(
  args: InstantiateArgs, env: EnvelopeBuilder, slot: UnitSlot, level: number, levelsTotal: number,
  existing: UnitInstance | undefined, slotKey: string,
): UnitInstance | null {
  const { b, ctx, f, deps } = args;
  const st = f.storeyId;
  const template = deps.templates.get(slot.templateId);
  if (!template) {
    b.warn(`unknown unit template ${slot.templateId} — slot skipped`);
    return null;
  }
  const id = existing?.id ?? makeUnitId(st, b.nextUnitIndex(st));

  // ---- boundary walls ----------------------------------------------------
  const boundaryWalls: UnitBoundaryWalls = {};
  const wallBySide = {} as Partial<Record<Side, WallDef>>;
  for (const side of ['front', 'rear', 'left', 'right'] as Side[]) {
    const spec = slot.sides[side];
    if (!spec) continue;
    const span = sideSpan(slot.boundary, side);
    if (slot.exteriorSides.includes(side) || spec.type === 'exterior') {
      const w = env.wallFor(side, span.across, span.a0, span.a1);
      if (w) {
        wallBySide[side] = w;
        boundaryWalls[side] = w;
        continue;
      }
    }
    const ext = spec.type === 'party' ? extensionsFor(slot, side) : { s: 0, e: 0 };
    const horizontal = side === 'front' || side === 'rear';
    const a0 = span.a0 - ext.s;
    const a1 = span.a1 + ext.e;
    const start: Vec2 = horizontal ? [a0, span.across] : [span.across, a0];
    const end: Vec2 = horizontal ? [a1, span.across] : [span.across, a1];
    const w = b.addWall({
      storey: st, start, end, thickness: spec.thickness, height: f.wallHeight, type: spec.type,
      isExternal: spec.type === 'exterior',
      loadBearingHint: spec.type === 'party' || spec.type === 'exterior' || spec.type === 'core',
      fireRating: spec.type === 'party' ? '1HR' : spec.type === 'corridor' ? '1HR' : undefined,
      unitId: spec.type === 'corridor' || spec.type === 'partition' ? id : undefined,
      exposure: spec.type === 'exterior' ? exposureOf(sideNormal(side), ctx.site.streetFacing) : undefined,
    });
    wallBySide[side] = w;
    boundaryWalls[side] = w;
  }

  // ---- net rect ----------------------------------------------------------
  const halves: Partial<Record<Side, number>> = {};
  for (const side of ['front', 'rear', 'left', 'right'] as Side[]) {
    halves[side] = (slot.sides[side]?.thickness ?? EXT) / 2;
  }
  const net = insetSides(slot.boundary, halves);
  if (net.w < 2.2 || net.h < 2.2) {
    b.warn(`unit slot ${slot.templateId} on ${st} is too small (${round(net.w, 2)}x${round(net.h, 2)} m) — skipped`);
    return null;
  }

  // ---- layout request ----------------------------------------------------
  const exposures: Partial<Record<Side, Compass>> = {};
  for (const side of slot.exteriorSides) exposures[side] = exposureOf(sideNormal(side), ctx.site.streetFacing);
  const balconySide = oppositeSide(slot.accessSide);
  const balconyDepth = ctx.spec.massing.balconyDepth ?? 0;
  const balRectPlanned = balconyRect(net, balconySide, balconyDepth);
  const wantBalcony = f.balconies
    && balconyDepth > 0.5
    && slot.exteriorSides.includes(balconySide)
    && level === levelsTotal - 1
    && balconyIsClear(args, slot, balRectPlanned);

  const req: UnitLayoutRequest = {
    unitId: id,
    template,
    rect: net,
    storey: st,
    level,
    levelsTotal,
    accessSide: slot.accessSide,
    exteriorSides: slot.exteriorSides,
    exposures,
    boundaryWalls,
    floorToFloor: f.floorToFloor,
    ceilingHeight: f.ceilingHeight,
    wwr: f.wwr,
    balcony: wantBalcony ? { side: balconySide, depth: balconyDepth } : null,
    region: ctx.spec.region,
    options: ctx.spec.options,
    rng: ctx.rng.fork(`unit:${slot.templateId}:${slot.index}:${level}`),
    wetWallSide: slot.accessSide,
    stackAlong: slot.stackAlong,
    stairRect: slot.stairRect,
  };

  let layout;
  try {
    layout = deps.layoutUnit(req);
  } catch (err) {
    b.warn(`layoutUnit failed for ${id} (${slot.templateId}): ${(err as Error).message}`);
    return null;
  }

  // ---- merge -------------------------------------------------------------
  const roomIds: string[] = [];
  for (const r of layout.rooms) {
    r.storey = st;
    r.unitId = id;
    if (!r.rect || r.rect.w === 0) r.rect = polygonBounds(r.polygon);
    if (!r.area) r.area = round(polygonArea(r.polygon), 3);
    if (!r.height) r.height = f.ceilingHeight;
    b.rooms.push(r);
    roomIds.push(r.id);
  }
  for (const w of layout.walls) {
    w.storey = st;
    w.unitId = id;
    if (!w.height) w.height = f.wallHeight;
    b.adoptWall(w);
  }
  const knownWalls = new Set<string>([...layout.walls.map(w => w.id), ...Object.values(wallBySide).map(w => w!.id)]);
  for (const d of layout.doors as DoorDef[]) {
    d.storey = st;
    d.unitId = id;
    if (!knownWalls.has(d.wallId)) {
      b.warn(`unit ${id}: door ${d.id} hosted in unknown wall ${d.wallId} — dropped`);
      continue;
    }
    b.doors.push(d);
  }
  for (const w of layout.windows as WindowDef[]) {
    w.storey = st;
    w.unitId = id;
    if (!knownWalls.has(w.wallId)) {
      b.warn(`unit ${id}: window ${w.id} hosted in unknown wall ${w.wallId} — dropped`);
      continue;
    }
    b.windows.push(w);
  }
  if (ctx.spec.options.furniture) {
    for (const fu of layout.furniture as FurnitureDef[]) {
      fu.storey = st;
      fu.unitId = id;
      b.furniture.push(fu);
    }
  }
  for (const p of layout.patterns) b.apply({ ...p, unitId: id, storey: st });
  for (const wmsg of layout.warnings) b.warn(`unit ${id}: ${wmsg}`);

  // internal stair for a multi-level dwelling
  if (layout.stair) {
    const s = layout.stair;
    const total = Math.max(2, s.risers);
    b.stairs.push({
      id: b.ids.next(st, 'STR'), coreId: '', storey: st,
      position: [round(s.position[0]), round(s.position[1])], direction: s.direction,
      risers: total, riserHeight: s.riserHeight, tread: s.tread, width: s.width,
      flights: 1, landingRect: s.rect, isExit: false,
    });
    b.stairRuns.push({
      id: b.ids.next(st, 'FLIGHT'), stairId: `${id}-STAIR`, coreId: '', storey: st,
      position: s.position, direction: s.direction, risers: total, riserHeight: s.riserHeight,
      tread: s.tread, width: s.width, z: 0, isExit: false,
    });
  }

  // extra organiser-owned doors (garage, private stair)
  const extraDoorIds: string[] = [];
  for (const ed of slot.extraDoors ?? []) {
    const host = wallBySide[ed.side];
    if (!host) continue;
    const len = dist(host.start, host.end);
    const along = clamp(ed.offset ?? len / 2, ed.width / 2 + 0.3, len - ed.width / 2 - 0.3);
    const d = b.addDoor({
      storey: st, wallId: host.id, along, width: ed.width, height: ed.height, type: ed.type,
      operation: ed.type === 'garage' ? 'ROLLINGUP' : 'SINGLE_SWING_RIGHT', unitId: id,
    });
    extraDoorIds.push(d.id);
    if (ed.type === 'garage') {
      b.apply({ patternId: 'ARC-11', storey: st, unitId: id, elementIds: [d.id], params: { garageDoorWidth: ed.width, garageDoorHeight: ed.height } });
    }
  }

  // ---- balcony -----------------------------------------------------------
  let balconyRoomId = layout.balconyRoomId;
  if (wantBalcony) {
    const balRect = balRectPlanned;
    if (!balconyRoomId) {
      const room = b.addRoom({
        storey: st, type: 'balcony', rect: balRect, unitId: id, height: f.ceilingHeight,
        name: 'Balcony', zone: 'outdoor',
      });
      balconyRoomId = room.id;
      roomIds.push(room.id);
      const host = wallBySide[balconySide];
      if (host) {
        b.addDoor({
          storey: st, wallId: host.id, along: dist(host.start, host.end) / 2, width: 1.6,
          height: 2.2, type: 'balcony', operation: 'DOUBLE_DOOR_SLIDING', unitId: id, toRoomId: room.id,
        });
      }
    }
    const balDef: BalconyDef = {
      id: b.ids.next(st, 'BALC'), storey: st, unitId: id, rect: balRect, roomId: balconyRoomId ?? '',
    };
    b.balconies.push(balDef);
    slabElement(b, st, balRect, 0.15, -0.15, 'FLOOR', 'Balcony slab', ['ARC-05'], id);
    const e = rectEdges(balRect);
    for (const side of ['front', 'rear', 'left', 'right'] as Side[]) {
      if (side === oppositeSide(balconySide)) continue;
      railingElement(b, st, e[side].a, e[side].b, 1.1, 0, ['ARC-05']);
    }
  }

  // ---- unit instance -----------------------------------------------------
  const rooms = layout.rooms;
  const netArea = round(rooms.filter(r => r.type !== 'balcony' && r.type !== 'terrace').reduce((s, r) => s + r.area, 0) || net.w * net.h, 2);
  const aspect = aspectOf(slot.exteriorSides);
  if (existing) {
    existing.storeys = [...new Set([...existing.storeys, st])];
    existing.area = round(existing.area + netArea, 2);
    existing.roomIds.push(...roomIds);
    existing.wetWallIds.push(...layout.wetWallIds);
    existing.bathroomRoomIds.push(...layout.bathroomRoomIds);
    if (!existing.kitchenRoomId) existing.kitchenRoomId = layout.kitchenRoomId;
    if (!existing.balconyRoomId) existing.balconyRoomId = balconyRoomId;
    return existing;
  }
  const inst: UnitInstance = {
    id,
    templateId: slot.templateId,
    storeys: slot.storeySpan ?? [st],
    rect: slot.boundary,
    polygon: rectToPolygon(slot.boundary),
    area: netArea,
    bedrooms: template.bedrooms,
    bathrooms: template.bathrooms,
    occupants: template.occupants,
    aspect,
    accessSide: slot.accessSide,
    entryDoorId: layout.entryDoorId || extraDoorIds[0] || '',
    roomIds,
    wetWallIds: [...layout.wetWallIds],
    kitchenRoomId: layout.kitchenRoomId,
    bathroomRoomIds: [...layout.bathroomRoomIds],
    balconyRoomId,
    barId: slot.barId,
    coreId: slot.coreId,
  };
  if (!inst.entryDoorId) {
    const host = wallBySide[slot.accessSide];
    if (host) {
      const d = b.addDoor({
        storey: st, wallId: host.id, along: dist(host.start, host.end) / 2, width: SIZES.doorUnitEntry,
        height: SIZES.doorHeight, type: 'unit-entry', operation: 'SINGLE_SWING_LEFT', unitId: id,
        fireRated: true, toRoomId: roomIds[0],
      });
      inst.entryDoorId = d.id;
      b.warn(`unit ${id}: layout returned no entry door — organiser inserted ${d.id}`);
    } else {
      b.warn(`unit ${id}: no entry door and no wall on the access side ${slot.accessSide}`);
    }
  }
  b.units.push(inst);
  args.unitRegistry.set(slotKey, inst);
  return inst;
}

/**
 * A balcony may only project into open air: in a courtyard or L/U plan the face opposite the access
 * can look straight at the next bar, and a balcony there would land inside someone's living room.
 */
function balconyIsClear(args: InstantiateArgs, slot: UnitSlot, bal: Rect): boolean {
  const probe = { x: bal.x + 0.05, y: bal.y + 0.05, w: Math.max(0.1, bal.w - 0.1), h: Math.max(0.1, bal.h - 0.1) };
  for (const other of args.layout.units) {
    if (other === slot) continue;
    if (rectsOverlap(probe, other.boundary, 0.02)) return false;
  }
  for (const c of args.layout.corridors) if (!c.external && rectsOverlap(probe, c.rect, 0.02)) return false;
  for (const c of args.layout.commons) if (rectsOverlap(probe, c.rect, 0.02)) return false;
  for (const c of args.cores) {
    if (rectsOverlap(probe, c.rect, 0.02)) return false;
    if (c.shaftBlock && rectsOverlap(probe, c.shaftBlock, 0.02)) return false;
  }
  const site = polygonBounds(args.ctx.site.boundary);
  if (!rectContainsRect(site, probe, 0.5)) return false;
  return true;
}

function extensionsFor(slot: UnitSlot, side: Side): { s: number; e: number } {
  const horizontal = side === 'front' || side === 'rear';
  const atA0: Side = horizontal ? 'left' : 'front';
  const atA1: Side = horizontal ? 'right' : 'rear';
  return {
    s: (slot.sides[atA0]?.thickness ?? 0) / 2,
    e: (slot.sides[atA1]?.thickness ?? 0) / 2,
  };
}

function balconyRect(net: Rect, side: Side, depth: number): Rect {
  const inset = 0.3;
  switch (side) {
    case 'front': return { x: round(net.x + inset), y: round(net.y - depth), w: round(Math.max(1, net.w - 2 * inset)), h: round(depth) };
    case 'rear': return { x: round(net.x + inset), y: round(net.y + net.h), w: round(Math.max(1, net.w - 2 * inset)), h: round(depth) };
    case 'left': return { x: round(net.x - depth), y: round(net.y + inset), w: round(depth), h: round(Math.max(1, net.h - 2 * inset)) };
    default: return { x: round(net.x + net.w), y: round(net.y + inset), w: round(depth), h: round(Math.max(1, net.h - 2 * inset)) };
  }
}

export function aspectOf(sides: Side[]): 'single' | 'dual' | 'corner' {
  const set = new Set(sides);
  if (set.size >= 3) return 'corner';
  if (set.size === 2) {
    const [a, c] = [...set];
    return oppositeSide(a) === c ? 'dual' : 'corner';
  }
  return 'single';
}

export type { FloorCtx, FloorLayout, UnitSlot, CommonRoomSlot, CorridorSlot };
export { rectToPolygon };
