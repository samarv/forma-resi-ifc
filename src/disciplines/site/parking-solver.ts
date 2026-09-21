/**
 * SIT-07 parking solver — demand becomes an INPUT to the massing instead of an output of it.
 *
 * v1 computed `required` from the massing's unit estimate after the form was fixed, packed
 * whichever single storey happened to carry `use: 'parking'`, and warned about the shortfall.
 * v2 runs `solveParking()` in `generateSite` BEFORE `buildMassing`:
 *
 *   units    = estimateUnits(spec, typology, frame)       pure; no bars needed
 *   required = ceil(units × ratio)                        ('none' owes nothing)
 *   levels   = surface yards | structured plates, each measured with stallCapacity()
 *   while short  → add a basement level   (info, resolution 'add-basement-level')
 *   while short  → add a podium level     (info, resolution 'add-podium-level')  [podiumUse allows it]
 *   still short  → deviation with the achieved ratio (resolution 'relax-parking-ratio')
 *
 * `applyParkingPlan` writes the resolved level counts back into `spec.massing` and re-runs
 * `resolveFloors` ONCE, so `buildStoreys`, architecture, structure and MEP all see the same
 * storey stack. `buildParking` then packs EVERY parking storey with the same `stallCapacity`
 * arithmetic, so the count the solver promised is the count that gets built.
 *
 * `stallCapacity` / `stallSlots` are THE capacity functions: `capacityOf` (yard ranking) and
 * `packZone`'s row arithmetic in v1 were two copies of the same maths and are both gone.
 * Structured levels are only added for structured parking types — a surface or garage scheme
 * that cannot meet its ratio relaxes the ratio rather than silently growing a garage.
 */
import type {
  BuildingSpec, TypologyDef, Rect, ParkingType, ParkingSpace, FloorSpec, FootprintShape,
} from '../../core/types.ts';
import type { Issue, RuleSet } from '../../core/rules/types.ts';
import { inset } from '../../core/geometry.ts';
import { SIZES } from '../../core/coordination.ts';
import { storeyIdFor } from '../../core/ids.ts';
import { resolveFloors } from '../../core/spec.ts';
import { clampNum } from './util.ts';
import { RULE, info, deviation, ruleNum, type IssueSink } from './issues.ts';
import { resolveDims, decomposeFootprint, gfaBreakdown, houseRow, GFA_PER_UNIT, type SiteFrame } from './massing.ts';

/** Ramp: one 3.5 × 12.0 m straight run per structured level (SIT-07). */
export const RAMP_W = 3.5;
export const RAMP_L = 12.0;
/** Structured plates are packed 0.4 m inside the storey outline (perimeter wall + tolerance). */
export const STRUCTURED_INSET = 0.4;

export interface StallOpts {
  stallW?: number;
  stallL?: number;
  aisleW?: number;
  accessibleW?: number;
  /** Accessible stalls to place first (they are wider, so they cost capacity) */
  accessible?: number;
  /** Every n-th standard stall is an EV stall (0 = none) */
  evEvery?: number;
  /** Area to hold back for a ramp when the ramp rect is not known yet (m²) */
  rampAllowance?: number;
  /** Exact ramp / obstruction footprint: slots overlapping it (plus `excludePad`) are dropped */
  exclude?: Rect;
  excludePad?: number;
}

export interface StallSlot {
  rect: Rect;
  type: ParkingSpace['type'];
  rotation: number;
}

export interface StallLayout {
  slots: StallSlot[];
  aisles: Rect[];
}

export interface ParkingLevel {
  storeyIndex: number;
  kind: 'surface' | 'basement' | 'podium';
  zone: Rect;
  capacity: number;
}

export interface ParkingPlan {
  type: ParkingType;
  /** Units the demand was computed from */
  units: number;
  required: number;
  /** Capacity the solved levels are predicted to hold */
  achieved: number;
  basementStoreys: number;
  podiumStoreys: number;
  podiumUse: 'retail' | 'parking' | 'amenity';
  levels: readonly ParkingLevel[];
  ratioRequested: number;
  ratioApplied: number;
  /**
   * Surface and garage parking is geometry (which yard, which bay), not a level count, so its
   * capacity is only known once the bars are placed: the plan defers the shortfall check to
   * `buildParking`, which records the same `relax-parking-ratio` deviation if the yards fall short.
   */
  deferred: boolean;
  issues: readonly Issue[];
}

// ---------------------------------------------------------------------------
// The single capacity function
// ---------------------------------------------------------------------------

export function stallOptsFrom(rules: RuleSet | undefined): StallOpts {
  return {
    stallW: ruleNum(rules, 'SIT-07.stallWidth', SIZES.parkingStallW),
    stallL: ruleNum(rules, 'SIT-07.stallLength', SIZES.parkingStallL),
    aisleW: ruleNum(rules, 'SIT-07.aisleWidth', SIZES.parkingAisleW),
    accessibleW: ruleNum(rules, 'SIT-07.accessibleWidth', SIZES.accessibleStallW),
  };
}

/** Accessible stalls owed for a lot of `n` stalls (IBC Table 1106.1, rounded up to 5 %). */
export function accessibleFor(n: number, rules?: RuleSet): number {
  return Math.ceil(Math.max(0, n) * ruleNum(rules, 'SIT-07.accessibleShare', 0.05));
}

/** EV stall pitch from the requested share: every n-th standard stall. */
export function evEveryFor(evShare: number): number {
  return evShare > 0 ? Math.max(1, Math.round(1 / evShare)) : 0;
}

/**
 * Every stall a zone holds, in packing order: double-loaded 16.8 m modules (row | aisle | row)
 * across the zone's short axis, then one single-loaded module (row | aisle) if the leftover
 * allows it; stalls along the rows with the accessible ones first.
 *
 * `rect` is always the axis-aligned footprint (already transposed for rows running along +Y)
 * and `rotation` is the bearing of the stall's long axis — see the note in parking.ts.
 */
export function stallSlots(zone: Rect, o: StallOpts = {}): StallLayout {
  const stallW = o.stallW ?? SIZES.parkingStallW;
  const stallL = o.stallL ?? SIZES.parkingStallL;
  const aisleW = o.aisleW ?? SIZES.parkingAisleW;
  const accW = o.accessibleW ?? SIZES.accessibleStallW;
  const evEvery = o.evEvery ?? 0;
  const pad = o.excludePad ?? 0.5;
  const slots: StallSlot[] = [];
  const aisles: Rect[] = [];
  if (!(zone.w > 0) || !(zone.h > 0)) return { slots, aisles };

  const alongX = zone.w >= zone.h;
  const along = alongX ? zone.w : zone.h;
  const across = alongX ? zone.h : zone.w;
  const acrossStart = alongX ? zone.y : zone.x;
  const alongStart = alongX ? zone.x : zone.y;

  // --- rows across the zone -------------------------------------------------
  const rowOffsets: number[] = [];
  let off = 0;
  for (;;) {
    const remain = across - off;
    if (remain >= 2 * stallL + aisleW - 1e-9) {
      rowOffsets.push(off, off + stallL + aisleW);
      aisles.push(bandRect(zone, alongX, off + stallL, aisleW));
      off += 2 * stallL + aisleW;
    } else if (remain >= stallL + aisleW - 1e-9) {
      rowOffsets.push(off);
      aisles.push(bandRect(zone, alongX, off + stallL, aisleW));
      break;
    } else break;
  }

  // --- stalls along each row ------------------------------------------------
  let acc = Math.max(0, o.accessible ?? 0);
  let standardIdx = 0;
  for (const rowOff of rowOffsets) {
    let a = 0;
    for (;;) {
      const useAcc = acc > 0 && a + accW <= along + 1e-9;
      const w = useAcc ? accW : stallW;
      if (a + w > along + 1e-9) break;
      const type: ParkingSpace['type'] = useAcc
        ? 'accessible'
        : (evEvery > 0 && standardIdx % evEvery === 0 ? 'ev' : 'standard');
      if (useAcc) acc--; else standardIdx++;
      const rect: Rect = alongX
        ? { x: alongStart + a, y: acrossStart + rowOff, w, h: stallL }
        : { x: acrossStart + rowOff, y: alongStart + a, w: stallL, h: w };
      a += w;
      if (o.exclude && overlaps(rect, o.exclude, pad)) continue;   // ramp / obstruction
      slots.push({ rect, type, rotation: alongX ? Math.PI / 2 : 0 });
    }
  }
  return { slots, aisles };
}

/**
 * Stalls a zone holds. THE capacity function: the solver sizes levels with it and `packZone`
 * emits exactly the slots it counts, so a promised capacity is always a buildable one.
 * `rampAllowance` (m²) is the pre-massing approximation used when the ramp rect is not known.
 */
export function stallCapacity(zone: Rect, o: StallOpts = {}): number {
  const n = stallSlots(zone, o).slots.length;
  if (o.exclude || !o.rampAllowance) return n;
  const stallArea = (o.stallW ?? SIZES.parkingStallW) * (o.stallL ?? SIZES.parkingStallL);
  return Math.max(0, n - Math.ceil(o.rampAllowance / Math.max(1e-6, stallArea)));
}

function bandRect(zone: Rect, alongX: boolean, offset: number, thickness: number): Rect {
  return alongX
    ? { x: zone.x, y: zone.y + offset, w: zone.w, h: thickness }
    : { x: zone.x + offset, y: zone.y, w: thickness, h: zone.h };
}

function overlaps(a: Rect, b: Rect, pad = 0): boolean {
  return a.x < b.x + b.w + pad && b.x - pad < a.x + a.w && a.y < b.y + b.h + pad && b.y - pad < a.y + a.h;
}

/** Packing zone of a structured parking plate: the storey outline less the perimeter wall. */
export function structuredZone(outline: Rect): Rect {
  const z = inset(outline, STRUCTURED_INSET);
  return { x: z.x, y: z.y, w: Math.max(1, z.w), h: Math.max(1, z.h) };
}

/** One straight ramp at the rear corner of a structured plate (deterministic from the zone). */
export function rampRect(zone: Rect): Rect {
  return {
    x: clampNum(zone.x + zone.w - RAMP_W - 0.5, zone.x, zone.x + Math.max(0, zone.w - RAMP_W)),
    y: clampNum(zone.y + zone.h - RAMP_L - 0.5, zone.y, zone.y + Math.max(0, zone.h - RAMP_L)),
    w: Math.min(RAMP_W, zone.w),
    h: Math.min(RAMP_L, zone.h),
  };
}

// ---------------------------------------------------------------------------
// Demand
// ---------------------------------------------------------------------------

/**
 * Dwellings the envelope supports, WITHOUT needing the bars: the same depth/length clipping,
 * shape decomposition and GFA-per-unit arithmetic `buildMassing` uses, run on the frame alone.
 * `site.test.ts` asserts it agrees with `MassingResult.estimatedUnits` within ±2 on every preset.
 */
export function estimateUnits(spec: BuildingSpec, typology: TypologyDef, frame: SiteFrame): number {
  const env = frame.env;
  const storeys = spec.massing.storeys;
  const dims = resolveDims(spec, typology, env);
  if (typology.access === 'direct') {
    return Math.max(1, houseRow(spec, typology, dims.length, dims.depth, storeys).count);
  }
  const requested: FootprintShape = spec.massing.footprintShape ?? typology.footprintShapes[0];
  const rects = decomposeFootprint(requested, env, dims.depth, dims.length, env.x + (env.w - dims.length) / 2, env.y)
    .parts.map(p => p.rect);
  const plateArea = rects.reduce((s, r) => s + r.w * r.h, 0);
  const podiumStoreys = Math.min(spec.massing.podiumStoreys ?? 0, storeys);
  const podiumArea = podiumStoreys > 0 ? env.w * env.h : plateArea;
  const g = gfaBreakdown(spec, plateArea, podiumArea, podiumStoreys);
  return Math.max(1, Math.round(g.residentialGfa / GFA_PER_UNIT));
}

// ---------------------------------------------------------------------------
// The solver
// ---------------------------------------------------------------------------

export interface SolveParkingInput {
  spec: BuildingSpec;
  typology: TypologyDef;
  frame: SiteFrame;
  estimatedUnits: number;
  rules?: RuleSet;
  sink: IssueSink;
}

/** Only these types put cars inside the building, so only these may grow a level. */
function structured(type: ParkingType): boolean {
  return type === 'podium' || type === 'underground';
}

export function solveParking(o: SolveParkingInput): ParkingPlan {
  const { spec, typology, frame, sink } = o;
  const p = spec.site.parking ?? {};
  const type: ParkingType = p.type ?? typology.parking;
  const ratio = p.ratio ?? typology.parkingRatio;
  const units = Math.max(0, o.estimatedUnits);
  const required = type === 'none' ? 0 : Math.max(0, Math.ceil(units * ratio));
  const podiumUse = spec.massing.podiumUse ?? 'retail';
  const opts: StallOpts = { ...stallOptsFrom(o.rules), accessible: accessibleFor(required, o.rules) };
  const issuesBefore = o.sink.all().length;

  const deferred = type === 'surface' || type === 'garage-attached';
  const levels: ParkingLevel[] = [];
  let basementStoreys = Math.max(0, spec.massing.basementStoreys ?? 0);
  let podiumStoreys = Math.max(0, Math.min(spec.massing.podiumStoreys ?? 0, spec.massing.storeys));
  const maxBasements = Math.max(basementStoreys, Math.round(
    ruleNum(o.rules, 'SIT-07.maxBasementStoreys', spec.massing.maxBasementStoreys ?? 3)));
  const maxPodium = Math.max(podiumStoreys, Math.round(
    ruleNum(o.rules, 'SIT-07.maxPodiumStoreys', spec.massing.maxPodiumStoreys ?? 3)));

  // --- what the spec already provides --------------------------------------
  const plateZone = structuredZone(frame.env);
  const plateCapacity = stallCapacity(plateZone, { ...opts, exclude: rampRect(plateZone) });
  let achieved = 0;
  if (deferred) {
    // Surface yards and garage bays are geometry, not levels: never grown here, and measured by
    // the packer once the bars are down.
    achieved = required;
    levels.push({ storeyIndex: 0, kind: 'surface', zone: frame.boundary, capacity: required });
  }
  if (structured(type) || basementStoreys > 0) {
    for (let b = 1; b <= basementStoreys; b++) {
      levels.push({ storeyIndex: -b, kind: 'basement', zone: plateZone, capacity: plateCapacity });
      achieved += plateCapacity;
    }
  }
  if (podiumUse === 'parking') {
    for (let i = 0; i < podiumStoreys; i++) {
      levels.push({ storeyIndex: i, kind: 'podium', zone: plateZone, capacity: plateCapacity });
      achieved += plateCapacity;
    }
  }

  // --- resolutions ----------------------------------------------------------
  if (structured(type) && plateCapacity > 0) {
    while (achieved < required && basementStoreys < maxBasements) {
      basementStoreys++;
      levels.push({ storeyIndex: -basementStoreys, kind: 'basement', zone: plateZone, capacity: plateCapacity });
      achieved += plateCapacity;
      sink.add(info(RULE.parkingLevels,
        `Parking: basement level ${basementStoreys} added to reach ${required} stalls (SIT-07).`, {
        storey: storeyIdFor(-basementStoreys),
        observed: achieved,
        limit: required,
        source: 'SIT-07 parking solver',
        resolution: { id: 'add-basement-level', from: basementStoreys - 1, to: basementStoreys },
      }));
    }
    while (achieved < required && podiumUse === 'parking' && podiumStoreys < maxPodium
      && podiumStoreys < spec.massing.storeys) {
      podiumStoreys++;
      levels.push({ storeyIndex: podiumStoreys - 1, kind: 'podium', zone: plateZone, capacity: plateCapacity });
      achieved += plateCapacity;
      sink.add(info(RULE.parkingLevels,
        `Parking: podium level ${podiumStoreys} added to reach ${required} stalls (SIT-07).`, {
        storey: storeyIdFor(podiumStoreys - 1),
        observed: achieved,
        limit: required,
        source: 'SIT-07 parking solver',
        resolution: { id: 'add-podium-level', from: podiumStoreys - 1, to: podiumStoreys },
      }));
    }
  }

  const ratioApplied = units > 0 ? Math.min(ratio, achieved / units) : ratio;
  if (required > 0 && achieved < required && !deferred) {
    sink.add(deviation(RULE.parkingRatio,
      `Parking: ${required} spaces required (${units} units × ${ratio}), ${achieved} can be built; ratio relaxed to ${ratioApplied.toFixed(2)} (SIT-07).`, {
      observed: achieved,
      limit: required,
      source: 'SIT-07 parking solver',
      resolution: { id: 'relax-parking-ratio', from: ratio, to: Number(ratioApplied.toFixed(3)) },
    }));
  }

  return {
    type, units, required, achieved, basementStoreys, podiumStoreys, podiumUse, levels,
    ratioRequested: ratio,
    ratioApplied: Number(ratioApplied.toFixed(3)),
    deferred,
    issues: o.sink.all().slice(issuesBefore),
  };
}

// ---------------------------------------------------------------------------
// Feeding the storey stack
// ---------------------------------------------------------------------------

/**
 * Write the solved level counts back into the spec and re-resolve the floor list ONCE, so
 * `buildStoreys` (and every discipline after site) sees the storeys the cars are parked on.
 * This is the one place site mutates its input spec; `SiteModel.derived` reports the result.
 */
export function applyParkingPlan(spec: BuildingSpec, typology: TypologyDef, plan: ParkingPlan): boolean {
  const b0 = Math.max(0, spec.massing.basementStoreys ?? 0);
  const p0 = Math.max(0, spec.massing.podiumStoreys ?? 0);
  if (plan.basementStoreys === b0 && plan.podiumStoreys === p0) return false;
  spec.massing.basementStoreys = plan.basementStoreys;
  spec.massing.podiumStoreys = plan.podiumStoreys;
  // A floor list resolved by `normalizeSpec` acts as its own override map, so the new podium
  // levels have to be re-marked here or `resolveFloors` would keep them residential.
  if (plan.podiumStoreys > p0 && plan.podiumUse === 'parking') {
    for (const f of spec.floors) {
      if (f.index >= p0 && f.index < plan.podiumStoreys) f.use = 'parking';
    }
  }
  spec.floors = resolveFloors(spec, typology);
  return true;
}

/** Parking storeys in packing order: the requested type's own levels first, then the others. */
export function parkingFloors(spec: BuildingSpec, type: ParkingType): FloorSpec[] {
  const floors = spec.floors.filter(f => f.use === 'parking');
  const wantBasement = type !== 'podium';
  const below = floors.filter(f => f.index < 0).sort((a, b) => b.index - a.index);   // B1, B2, …
  const above = floors.filter(f => f.index >= 0).sort((a, b) => a.index - b.index);  // L01, L02, …
  return wantBasement ? [...below, ...above] : [...above, ...below];
}
