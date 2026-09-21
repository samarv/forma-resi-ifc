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
} from '../../core/types.ts';
import type { ProfileBook, ProfileId } from '../../core/kernel/types.ts';
import type { Issue, Ledger, RuleSet } from '../../core/rules/types.ts';

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

export function presizeStructure(_i: PresizeInput): StructuralPresize {
  throw new Error('presizeStructure: not implemented yet (wave 1, structure agent)');
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
