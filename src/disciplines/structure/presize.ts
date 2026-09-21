/**
 * F3 — Structural pre-sizing (frozen header; body implemented by the structure agent in wave 1).
 *
 * Runs BEFORE architecture, from site.massing + storeys + typology only, and is the single owner of every structural
 * number the other disciplines consume: slab thickness per storey, beam depth per storey/use, core and shear wall
 * thickness, column band, corridor soffit and ceiling per storey, the transfer storey and its zone depth, and the bay
 * proposal architecture snaps party walls to. It also resolves each storey's ceiling profile (kernel) and may RAISE a
 * floor-to-floor when the profile cannot fit — recorded as a deviation and reflected in `storeysResolved`.
 */
import type {
  BuildingSpec, TypologyDef, SiteModel, StoreyDef, FloorUse, StructuralSystemId, FoundationType,
  CorePlacement, CorridorSpine, MassingBar, Rect,
} from '../../core/types.ts';
import type { ProfileBook, ProfileId } from '../../core/kernel/types.ts';
import type { Issue, Ledger, RuleSet } from '../../core/rules/types.ts';
import { polygonBounds, round } from '../../core/geometry.ts';
import { FOUNDATION_STOREY, ROOF_STOREY, storeyIdFor } from '../../core/ids.ts';
import { foundationFor, structuralSystemFor } from '../../core/typologies.ts';
import { stackProfile } from './profiles-seam.ts';
import {
  GRID_RULES, LIVE_CORRIDOR_KPA, TRANSFER, clamp, columnBand, columnMaterialFor, isHybridPodiumSystem,
  loadsFor, sizesFor,
} from './sizing.ts';
import { SPLIT_TOLERANCE } from './grid.ts';

export interface PresizeLoads { deadKpa: number; liveKpa: number; roofLiveKpa: number; liveCorridorKpa: number; }
export interface PresizeSizes { columnW: number; columnD: number; beamW: number; beamD: number; slabT: number; shearWallT: number; }

export interface StoreySizing {
  storey: string;
  index: number;
  use: FloorUse | 'site' | 'foundation' | 'roof';
  profileId: ProfileId;
  /** may have been RAISED by the presize so the ceiling profile fits */
  floorToFloor: number;
  /** slab whose soffit forms this storey's ceiling */
  slabTAbove: number;
  /** structural depth below that slab over the corridor / over the unit (0 for a flat slab) */
  beamDAbove: number;
  beamDAboveUnit: number;
  soffitZ: number;
  corridorSoffitZ: number;
  ceilingZ: number;
  corridorCeilingZ: number;
  /** this storey's slab ABOVE is the transfer slab */
  isTransferBelow: boolean;
  transferZoneDepth: number;
  /** slab of THIS storey (position.z = -slabTOwn) for the detailing pass */
  slabTOwn: number;
}

export interface GridProposal {
  longAxis: 'x' | 'y';
  bay: { min: number; target: number; max: number; source: string };
  transverse: { barId: string; axis: 'x' | 'y'; offsets: number[] }[];
  longitudinal: { barId: string; axis: 'x' | 'y'; offsets: number[] }[];
  parkingModule: { along: number; across: number };
  /** how far a returned party wall may move before structure would have to kink */
  snapTolerance: number;
}

export interface StructuralPresize {
  system: StructuralSystemId;
  foundation: FoundationType;
  loads: PresizeLoads;
  sizes: PresizeSizes;
  columnBand: { min: number; max: number };
  coreWallT: number;
  shearWallT: number;
  partyWallT: number;
  exteriorWallT: number;
  corridorWallT: number;
  storeys: readonly StoreySizing[];
  byStorey: Map<string, StoreySizing>;
  /** corrected storey list (elevations recomputed if any f2f was raised) */
  storeysResolved: StoreyDef[];
  /** storey whose FLOOR slab is the transfer slab = storeyIdFor(podiumStoreys) */
  transferStorey: string | null;
  /** storey BELOW it, whose ceiling carries the transfer depth */
  transferBelowStorey: string | null;
  transferSlabT: number;
  transferBeamD: number;
  transferZoneDepth: number;
  podiumStoreys: number;
  gridProposal: GridProposal;
  issues: readonly Issue[];
}

export interface PresizeInput {
  spec: BuildingSpec;
  typology: TypologyDef;
  site: SiteModel;
  storeys: readonly StoreyDef[];
  profiles: ProfileBook;
  rules: RuleSet;
  ledger: Ledger;
}

// ---------------------------------------------------------------------------------------------------------------
// Bay proposal (STR-02 / STR-09) — the along-bar structural rhythm architecture snaps party walls to
// ---------------------------------------------------------------------------------------------------------------

/** Admissible along-bar bay band per system. Fallbacks are today's constants; rules may override them. */
function bayBandFor(system: StructuralSystemId): { min: number; target: number; max: number; source: string } {
  switch (system) {
    case 'steel-frame':
      return { min: 6.0, target: 9.0, max: 12.0, source: 'AISC Design Guide 3; composite deck with secondary beams at 3 m' };
    case 'rc-flat-slab':
    case 'rc-flat-plate-core':
      return { min: 6.0, target: GRID_RULES.pointPlateTarget, max: GRID_RULES.maxSpacing, source: 'ACI 318-19 Table 8.3.1.1; EN 1992-1-1 §7.4.2 (flat slab span/depth ≈ 30)' };
    case 'mass-timber-clt':
      return { min: GRID_RULES.minSpacing, target: 7.2, max: GRID_RULES.maxSpacing, source: 'CLT 5-ply residential spans; glulam GL24h transverse band' };
    case 'wood-over-podium':
      return { min: GRID_RULES.minSpacing, target: GRID_RULES.pointPlateTarget, max: GRID_RULES.maxSpacing, source: 'party-wall rhythm above the podium; podium frame on the parking module (STR-04)' };
    default:
      // light-wood-frame, masonry-bearing: the party-wall rhythm is a planning module, the joists span across the bar
      return { min: GRID_RULES.minSpacing, target: 6.0, max: GRID_RULES.maxSpacing, source: 'NDS 2018 / CSA O86-19 joist span tables; party walls on the unit frontage' };
  }
}

export function proposeBay(
  typology: TypologyDef, site: SiteModel, spec: BuildingSpec, rules: RuleSet,
): GridProposal['bay'] {
  const storeyCount = Math.max(1, spec.massing.storeys);
  const band = bayBandFor(structuralSystemFor(typology, storeyCount));
  const min = rules.num('STR-02.minSpacing', band.min);
  const max = rules.num('STR-02.maxSpacing', band.max);
  // A bar's own frontage rhythm beats the generic target when site has already decomposed the massing
  const bars = site.massing?.bars ?? [];
  const perFloor = Math.max(1, typology.unitsPerFloor.min + typology.unitsPerFloor.max) / 2;
  const implied = bars.length > 0 && perFloor > 0
    ? (bars[0].axis === 'x' ? bars[0].rect.w : bars[0].rect.h) / Math.max(1, Math.round(perFloor / (typology.access === 'corridor-double' ? 2 : 1)))
    : band.target;
  const target = clamp(rules.num('STR-02.targetSpacingPointPlate', Number.isFinite(implied) && implied > 0 ? implied : band.target), min, max);
  return { min, target: round(target, 3), max, source: band.source };
}

/**
 * Bay lines from `a0` to `a1`: interior bays at the target, the corner bay absorbing the remainder, never
 * outside [min, max]. Falls back to a uniform division when the corner bay would exceed the maximum.
 */
export function bayOffsets(a0: number, a1: number, bay: GridProposal['bay']): number[] {
  const span = a1 - a0;
  if (!Number.isFinite(span) || span <= 0.01) return [round(a0, 4)];
  const min = Math.max(0.5, bay.min);
  const max = Math.max(min, bay.max);
  if (span <= max + 1e-9) return [round(a0, 4), round(a1, 4)];
  const step = clamp(bay.target, min, max);
  let n = Math.max(1, Math.ceil(span / step - 1e-9));
  let rem = span - (n - 1) * step;
  while (n > 1 && rem < min - 1e-9) { n -= 1; rem = span - (n - 1) * step; }
  if (rem > max + 1e-9) {
    // Uniform division: the fewest bays that respect the maximum
    const m = Math.max(1, Math.ceil(span / max - 1e-9));
    const u = span / m;
    // A bay shorter than the minimum is worse than one clear span within the split tolerance (grid.ts SPLIT_TOLERANCE)
    if (u < min - 1e-9 && span <= max * SPLIT_TOLERANCE) return [round(a0, 4), round(a1, 4)];
    const out: number[] = [];
    for (let k = 0; k <= m; k++) out.push(round(a0 + u * k, 4));
    return out;
  }
  const out: number[] = [];
  for (let k = 0; k < n; k++) out.push(round(a0 + step * k, 4));
  out.push(round(a1, 4));
  return out;
}

/**
 * Fold must-keep lines (core edges) into a bay set, dropping any proposed line within `min/2` of one and
 * subdividing whatever gap that opens, so the result still honours `bay.max`.
 */
function withMustKeep(offsets: number[], mustKeep: number[], bay: GridProposal['bay']): number[] {
  const keep = mustKeep.filter(v => Number.isFinite(v)).map(v => round(v, 4));
  if (keep.length === 0) return offsets;
  const lo = offsets[0];
  const hi = offsets[offsets.length - 1];
  const tol = Math.max(0.25, bay.min / 2);
  const kept = offsets.filter((v, k) => k === 0 || k === offsets.length - 1 || !keep.some(m => Math.abs(m - v) < tol));
  for (const m of keep) if (m > lo + tol && m < hi - tol) kept.push(m);
  const merged = dedupe(kept, 0.05);
  const out: number[] = [merged[0]];
  for (let k = 1; k < merged.length; k++) {
    const gap = merged[k] - merged[k - 1];
    if (gap > bay.max + 1e-6) {
      const n = Math.ceil(gap / bay.max - 1e-9);
      for (let j = 1; j < n; j++) out.push(round(merged[k - 1] + (gap * j) / n, 4));
    }
    out.push(merged[k]);
  }
  return out;
}

function dedupe(raw: number[], tol: number): number[] {
  const sorted = [...raw].filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) if (out.length === 0 || v - out[out.length - 1] > tol) out.push(round(v, 4));
  return out;
}

/** Half-bay tributary extent each side of the widest line of a set (m) */
function maxTributary(offsets: number[], fallback: number): number {
  if (offsets.length < 2) return fallback;
  let best = 0;
  for (let k = 0; k < offsets.length; k++) {
    const prev = k > 0 ? (offsets[k] - offsets[k - 1]) / 2 : 0;
    const next = k + 1 < offsets.length ? (offsets[k + 1] - offsets[k]) / 2 : 0;
    best = Math.max(best, prev + next);
  }
  return best > 0.1 ? best : fallback;
}

function spineOffsetOf(spine: CorridorSpine, constAxis: 'x' | 'y'): number {
  const c = spine.centerline;
  return constAxis === 'x' ? (c.a[0] + c.b[0]) / 2 : (c.a[1] + c.b[1]) / 2;
}

// ---------------------------------------------------------------------------------------------------------------
// presizeStructure
// ---------------------------------------------------------------------------------------------------------------

/** Corridors/lobbies inherit the corridor profile; everything else resolves its ceiling on its own profile */
function corridorProfileFor(main: ProfileId): ProfileId {
  return main === 'resi-unit' ? 'resi-corridor' : main;
}

export function presizeStructure(i: PresizeInput): StructuralPresize {
  const { spec, typology, site, profiles, rules, ledger } = i;
  const issues: Issue[] = [];
  const record = (key: string, d: Parameters<Ledger['add']>[0]): void => {
    const added = ledger.addOnce(key, d);
    if (added) issues.push(added);
  };

  // ------------------------------------------------------------------ storeys
  const byIndex = (a: StoreyDef, b: StoreyDef): number => a.index - b.index;
  const aboveGrade = i.storeys.filter(s => s.index >= 0 && s.index < 100).sort(byIndex);
  const basements = i.storeys.filter(s => s.index < 0 && s.index > -100).sort(byIndex);
  const framed = [...basements, ...aboveGrade];
  const roofStorey = i.storeys.find(s => s.id === ROOF_STOREY) ?? null;
  const fndStorey = i.storeys.find(s => s.id === FOUNDATION_STOREY) ?? null;
  const storeyCount = Math.max(1, aboveGrade.length);
  const lowest = framed[0] ?? aboveGrade[0] ?? i.storeys[0];

  // ------------------------------------------------------------------ system, foundation, podium
  const system: StructuralSystemId = structuralSystemFor(typology, storeyCount);
  const parkingType = spec.site.parking?.type ?? typology.parking;
  const foundation: FoundationType = foundationFor(system, storeyCount, parkingType);
  let podiumStoreys = spec.massing.podiumStoreys ?? 0;
  if (isHybridPodiumSystem(system) && podiumStoreys < 1) podiumStoreys = 1;
  podiumStoreys = Math.min(podiumStoreys, Math.max(0, storeyCount - 1));
  // THE transfer storey: its FLOOR slab is the transfer slab. Architecture used to thicken `index + 1 ===
  // podiumStoreys` (one storey low) — there is now exactly one owner of both numbers.
  const transferStorey = podiumStoreys > 0 ? storeyIdFor(podiumStoreys) : null;
  const transferBelowStorey = podiumStoreys > 0 ? storeyIdFor(podiumStoreys - 1) : null;
  const transferSlabT = rules.num('STR-04.transferSlabThickness', TRANSFER.slabT);
  const transferBeamD = rules.num('STR-04.transferBeamDepth', TRANSFER.beamD);
  const transferZoneDepth = rules.num('STR-04.transferZoneDepth', round(transferSlabT + transferBeamD, 4));

  // ------------------------------------------------------------------ loads
  const base = loadsFor(system);
  const loads: PresizeLoads = {
    deadKpa: rules.num('STR-01.deadKpa', base.deadKpa),
    liveKpa: rules.num('STR-01.liveKpa', base.liveKpa),
    roofLiveKpa: rules.num('STR-11.roofLiveLoad', base.roofLiveKpa),
    liveCorridorKpa: rules.num('STR-01.liveCorridorKpa', LIVE_CORRIDOR_KPA),
  };

  // ------------------------------------------------------------------ grid proposal
  const exteriorWallT = rules.num('STR-02.exteriorWallT', 0.3);
  const partyWallT = rules.num('STR-02.partyWallT', 0.25);
  const corridorWallT = rules.num('STR-02.corridorWallT', 0.2);
  const bay = proposeBay(typology, site, spec, rules);
  const massing = site.massing;
  const footprint = massing?.footprint ?? [];
  const fpBounds: Rect = footprint.length >= 3 ? polygonBounds(footprint) : { x: 0, y: 0, w: Math.max(6, spec.massing.buildingLength ?? 20), h: Math.max(6, spec.massing.buildingDepth ?? 12) };
  const bars: readonly MassingBar[] = massing?.bars?.length
    ? massing.bars
    : [{ id: 'BAR-1', rect: fpBounds, axis: fpBounds.w >= fpBounds.h ? 'x' : 'y', depth: Math.min(fpBounds.w, fpBounds.h), length: Math.max(fpBounds.w, fpBounds.h), exteriorSides: [] }];
  const spines: readonly CorridorSpine[] = massing?.corridors ?? [];
  const cores: readonly CorePlacement[] = massing?.cores ?? [];
  const longAxis: 'x' | 'y' = bars[0].axis;

  const transverse: GridProposal['transverse'] = [];
  const longitudinal: GridProposal['longitudinal'] = [];
  for (const barDef of bars) {
    const along = barDef.axis;
    const across: 'x' | 'y' = along === 'x' ? 'y' : 'x';
    const r = barDef.rect;
    const a0 = (along === 'x' ? r.x : r.y) + exteriorWallT / 2;
    const a1 = (along === 'x' ? r.x + r.w : r.y + r.h) - exteriorWallT / 2;
    const coreEdges: number[] = [];
    for (const c of cores) {
      if (c.barId !== barDef.id) continue;
      coreEdges.push(along === 'x' ? c.rect.x : c.rect.y, along === 'x' ? c.rect.x + c.rect.w : c.rect.y + c.rect.h);
    }
    transverse.push({ barId: barDef.id, axis: along, offsets: withMustKeep(bayOffsets(a0, a1, bay), coreEdges, bay) });

    const b0 = (across === 'x' ? r.x : r.y) + exteriorWallT / 2;
    const b1 = (across === 'x' ? r.x + r.w : r.y + r.h) - exteriorWallT / 2;
    const longOffsets: number[] = [b0, b1];
    for (const sp of spines) {
      if (sp.barId !== barDef.id) continue;
      const at = spineOffsetOf(sp, across);
      longOffsets.push(at - sp.width / 2, at + sp.width / 2);
    }
    if (longOffsets.length === 2 && b1 - b0 > 11) longOffsets.push((b0 + b1) / 2);
    longitudinal.push({ barId: barDef.id, axis: across, offsets: dedupe(longOffsets, 0.05) });
  }

  const gridProposal: GridProposal = {
    longAxis,
    bay,
    transverse,
    longitudinal,
    parkingModule: {
      along: rules.num('STR-04.parkingModuleAlongBar', TRANSFER.moduleAlong),
      across: rules.num('STR-04.parkingModuleAcross', TRANSFER.moduleAcross),
    },
    snapTolerance: rules.num('STR-03.snapTolerance', GRID_RULES.snapDistance),
  };

  // ------------------------------------------------------------------ member sizes
  const tribAlong = maxTributary(transverse[0]?.offsets ?? [], bay.target);
  const tribAcross = maxTributary(longitudinal[0]?.offsets ?? [], Math.min(bars[0].depth, 9) / 2);
  const typicalTributary = Math.max(4, tribAlong * tribAcross);
  const sized = sizesFor(system, storeyCount, typicalTributary, loads);
  const colMaterial = columnMaterialFor(system);
  const band = columnBand(colMaterial);
  const slabT = rules.num('STR-09.slabThickness', sized.slabT);
  const beamD = rules.num('STR-09.beamDepth', sized.beamD);

  // STR-05: the core is the lateral system above the flat-slab band, and a special structural wall is 0.30 thick
  // (ACI 318-19 §18.10.2.1 / EN 1998-1 §5.4.1.2.3). Below that a 0.25 m RC core wall is a 2-hour fire enclosure.
  const shearCoreAbove = rules.num('STR-05.shearCoreAboveStoreys', 12);
  const coreIsShearSpine = system === 'rc-flat-plate-core' || storeyCount > shearCoreAbove;
  const shearWallT = coreIsShearSpine
    ? rules.num('STR-05.designShearWallThickness', 0.3)
    : rules.num('STR-05.lowRiseCoreWallThickness', 0.25);
  const coreWallT = shearWallT;
  const sizes: PresizeSizes = {
    columnW: sized.columnW,
    columnD: sized.columnD,
    beamW: sized.beamW,
    beamD,
    slabT,
    shearWallT,
  };

  // ------------------------------------------------------------------ slab thicknesses per storey
  const groundSlabT = Math.max(slabT, basements.length > 0 || lowest.use === 'parking'
    ? rules.num('STR-06.basementSlabThickness', 0.3)
    : rules.num('STR-06.groundSlabThickness', 0.25));
  const slabTOwnOf = (s: StoreyDef): number => {
    if (s.id === FOUNDATION_STOREY) return 0;
    if (transferStorey && s.id === transferStorey) return transferSlabT;
    if (s.id === lowest.id) return groundSlabT;
    return slabT;
  };
  const orderIndex = new Map<string, number>(framed.map((s, k) => [s.id, k]));
  const storeyAbove = (s: StoreyDef): StoreyDef | null => {
    const k = orderIndex.get(s.id);
    if (k === undefined) return s.id === FOUNDATION_STOREY ? lowest : null;
    return k + 1 < framed.length ? framed[k + 1] : roofStorey;
  };
  // Downstand beams cross the ceiling only where the floor system has them; a flat slab / flat plate and a
  // platform-framed cassette present a flat soffit (the rim beam sits in the wall zone).
  const hasDownstand = system === 'steel-frame' || system === 'mass-timber-clt';
  // A direct-access typology (houses, terraces, ADUs) has no internal corridor to run services along, so its
  // ceiling is resolved on the dwelling profile alone. Everything else has a corridor or a lift lobby.
  const hasCorridors = typology.access !== 'direct' || (massing?.corridors?.length ?? 0) > 0;

  // ------------------------------------------------------------------ per-storey sizing, with the raise loop
  const sizingOf = (s: StoreyDef, f2f: number): { sizing: StoreySizing; raiseTo: number | null } => {
    const above = storeyAbove(s);
    const slabTAbove = above ? slabTOwnOf(above) : slabT;
    const isTransferBelow = transferBelowStorey !== null && s.id === transferBelowStorey;
    const zone = isTransferBelow ? transferZoneDepth : 0;
    const beamDAbove = hasDownstand ? beamD : 0;
    const beamDAboveUnit = beamDAbove;
    const use: FloorUse | 'site' | 'foundation' | 'roof' = s.id === ROOF_STOREY ? 'roof' : s.use;
    const profileId = profiles.resolve(use);
    const corridorId = hasCorridors ? corridorProfileFor(profileId) : profileId;
    // Only the transfer BEAM hangs below the slab soffit: `soffitZ` has already taken the transfer slab off.
    const zoneBelowSoffit = zone > 0 ? Math.max(0, zone - slabTAbove) : 0;
    const common = {
      storey: s.id, floorToFloor: f2f, slabTAbove, beamDAbove, beamDAboveUnit, transferZoneDepth: zoneBelowSoffit, rules,
    };
    const main = stackProfile({ profile: profiles.profile(profileId), ...common });
    const corr = corridorId === profileId
      ? main
      : stackProfile({ profile: profiles.profile(corridorId), ...common });
    const soffitZ = round(f2f - slabTAbove, 4);
    const corridorSoffitZ = round(soffitZ - Math.max(zoneBelowSoffit, beamDAbove), 4);
    const unitSoffitZ = round(soffitZ - Math.max(zoneBelowSoffit, beamDAboveUnit), 4);
    // Only `retail-shell` carries a `transfer` band, so on a parking / lobby / amenity podium the kernel's
    // resolved ceiling does not see the transfer beams. The pre-sizing owns the structural depth, so the two
    // published numbers are reconciled here rather than left to contradict each other: a ceiling can never be
    // above the structure that is actually there.
    const ceilingZ = Math.min(main.resolved.ceilingZ, unitSoffitZ);
    const corridorCeilingZ = Math.min(corr.resolved.ceilingZ, corridorSoffitZ);
    const raiseTo = Math.max(main.raiseFloorToFloorTo ?? 0, corr.raiseFloorToFloorTo ?? 0);
    return {
      sizing: {
        storey: s.id,
        index: s.index,
        use,
        profileId,
        floorToFloor: round(f2f, 4),
        slabTAbove: round(slabTAbove, 4),
        beamDAbove: round(beamDAbove, 4),
        beamDAboveUnit: round(beamDAboveUnit, 4),
        soffitZ,
        corridorSoffitZ,
        ceilingZ: round(ceilingZ, 4),
        corridorCeilingZ: round(corridorCeilingZ, 4),
        isTransferBelow,
        transferZoneDepth: round(zone, 4),
        slabTOwn: round(slabTOwnOf(s), 4),
      },
      raiseTo: raiseTo > 0 ? raiseTo : null,
    };
  };

  const storeySizings: StoreySizing[] = [];
  const resolvedHeight = new Map<string, number>();
  const all: StoreyDef[] = [...framed];
  if (roofStorey) all.push(roofStorey);
  if (fndStorey) all.push(fndStorey);
  /** Never raise a storey by more than this: beyond it the input, not the plenum, is wrong. */
  const maxRaise = rules.num('STR-09.maxFloorToFloorRaise', 2.5);
  for (const s of all) {
    // The ROOF parapet and the FND depth are not occupiable storeys — record their sizing, never raise them.
    const raiseable = s.id !== ROOF_STOREY && s.id !== FOUNDATION_STOREY;
    const original = s.height;
    let f2f = original;
    let r = sizingOf(s, f2f);
    // Raising the storey moves the bands, which can reveal a little more depth is needed; two or three passes
    // converge. Only ONE deviation is recorded, from the original height to the final one.
    for (let pass = 0; raiseable && r.raiseTo !== null && pass < 4; pass++) {
      const next = Math.min(r.raiseTo, original + maxRaise);
      if (next <= f2f + 1e-9) break;
      f2f = next;
      r = sizingOf(s, f2f);
    }
    if (f2f > original + 1e-9) {
      record(`presize.raise:${s.id}`, {
        severity: 'deviation',
        ruleId: 'XD-02.plenumDepth',
        discipline: 'structure',
        storey: s.id,
        message: `floor-to-floor on ${s.id} raised from ${original.toFixed(2)} m to ${f2f.toFixed(2)} m: the ${r.sizing.profileId} ceiling profile does not fit under a ${(original - r.sizing.slabTAbove - Math.max(0, r.sizing.transferZoneDepth - r.sizing.slabTAbove)).toFixed(2)} m soffit above its ${profiles.profile(r.sizing.profileId).clearHeight.min.toFixed(2)} m clear height.`,
        observed: round(original, 3),
        limit: round(f2f, 3),
        source: 'IBC 2021 §1208.2 / §1003.2 clear height + the resolved band stack',
        resolution: { id: 'raise-floor-to-floor', from: round(original, 3), to: round(f2f, 3) },
      });
    }
    resolvedHeight.set(s.id, f2f);
    storeySizings.push(r.sizing);
  }
  storeySizings.sort((a, b) => a.index - b.index);

  // ------------------------------------------------------------------ resolved storey list (elevations recomputed)
  const storeysResolved = resolveElevations(i.storeys, resolvedHeight);

  const byStorey = new Map<string, StoreySizing>(storeySizings.map(s => [s.storey, s]));
  return {
    system,
    foundation,
    loads,
    sizes,
    columnBand: band,
    coreWallT,
    shearWallT,
    partyWallT,
    exteriorWallT,
    corridorWallT,
    storeys: storeySizings,
    byStorey,
    storeysResolved,
    transferStorey,
    transferBelowStorey,
    transferSlabT,
    transferBeamD,
    transferZoneDepth,
    podiumStoreys,
    gridProposal,
    issues,
  };
}

/**
 * Rebuild every storey elevation from the (possibly raised) floor-to-floor heights, mirroring `buildStoreys`:
 * above-grade levels stack up from 0, basements stack down from 0, FND sits a foundation depth below the lowest
 * floor, ROOF sits on top. Order and identity of the input list are preserved.
 */
function resolveElevations(storeys: readonly StoreyDef[], heights: Map<string, number>): StoreyDef[] {
  const h = (s: StoreyDef): number => heights.get(s.id) ?? s.height;
  const byIndex = (a: StoreyDef, b: StoreyDef): number => a.index - b.index;
  const basements = storeys.filter(s => s.index < 0 && s.index > -100).sort(byIndex);
  const above = storeys.filter(s => s.index >= 0 && s.index < 100).sort(byIndex);
  const elevation = new Map<string, number>();

  let e = 0;
  for (const b of [...basements].reverse()) e -= h(b);
  const lowestElevation = e;
  for (const b of basements) { elevation.set(b.id, round(e, 4)); e += h(b); }
  e = 0;
  for (const s of above) { elevation.set(s.id, round(e, 4)); e += h(s); }
  const roofElevation = round(e, 4);

  return storeys.map(s => {
    const height = round(h(s), 4);
    if (s.id === ROOF_STOREY) return { ...s, height, elevation: roofElevation };
    if (s.id === FOUNDATION_STOREY) return { ...s, height, elevation: round(lowestElevation - height, 4) };
    const el = elevation.get(s.id);
    return el === undefined ? { ...s, height } : { ...s, height, elevation: el };
  });
}

/** The placer's view of the pre-sizing: planning module + admissible bay/span bands + the thicknesses architecture must adopt */
export interface BayGrid {
  /** planning module the placer snaps party walls to (m) */
  module: number;
  /** admissible structural bay spacing ALONG the bar */
  bay: { min: number; target: number; max: number };
  /** admissible span ACROSS the bar */
  span: { min: number; target: number; max: number };
  slabT: number;
  beamDepth: number;
  coreWallT: number;
  shearWallT: number;
  source: 'presize' | 'default';
}

export function bayGridFrom(p: StructuralPresize): BayGrid {
  const typical = p.storeys.find(s => s.use === 'residential') ?? p.storeys[0];
  return {
    module: 0.1,
    bay: { min: p.gridProposal.bay.min, target: p.gridProposal.bay.target, max: p.gridProposal.bay.max },
    span: { min: 4.0, target: 7.5, max: 9.0 },
    slabT: typical?.slabTAbove ?? p.sizes.slabT,
    beamDepth: typical?.beamDAbove ?? p.sizes.beamD,
    coreWallT: p.coreWallT,
    shearWallT: p.shearWallT,
    source: 'presize',
  };
}

/** Fallback for tests and for the placer before the presize lands: today's constants */
export function defaultBayGrid(system: StructuralSystemId): BayGrid {
  const flatPlate = system === 'rc-flat-plate-core';
  return {
    module: 0.1,
    bay: { min: 4.0, target: 7.5, max: 9.0 },
    span: { min: 4.0, target: 7.5, max: 9.0 },
    slabT: flatPlate ? 0.25 : 0.2,
    beamDepth: flatPlate ? 0 : 0.5,
    coreWallT: 0.25,
    shearWallT: 0.3,
    source: 'default',
  };
}
