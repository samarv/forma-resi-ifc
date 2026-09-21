/**
 * v1 compatibility shim — deleted in wave 3.
 *
 * The facts this file used to own now live in the coordination kernel:
 *   `MOUNTING`      → `core/kernel/mounting.ts` (moved verbatim);
 *   `SIZES`         → `core/kernel/sizes.ts` as `ELEMENT_SIZES`, **minus `slabT` and `coreWallT`**, which are
 *                     structural facts owned by `StructuralPresize` (`byStorey.get(s).slabTAbove`, `coreWallT`).
 *                     The two doomed keys are still exported here so architecture, structure and site can migrate
 *                     one file at a time;
 *   `plenumBands`   → `core/kernel/profiles.ts` (`stackProfile`), where the corridor ceiling is an OUTPUT of the
 *                     ceiling profile rather than an input;
 *   `DEFAULT_LANES` → `core/kernel/lanes.ts`, where a lane has a width as well as an offset;
 *   `lanePath`      → `core/kernel/lanes.ts` (`lanePathIn`), which also takes the allocator's lateral shift.
 *
 * Until M1/M2 route their runs through `kernel.reserveLaneRun` / `reserveCrossing`, the four v1 numbers this file
 * returns must stay bit-identical, so `plenumBands` keeps the v1 offsets (0.05 + 0.15 under the structure, pipes
 * 0.25 under the duct axis) and anchors them on the profile's resolved `soffitZ` / `structureBottomZ`, and
 * `DEFAULT_LANES` projects the frozen v1 lane offsets. A literal projection of the v2 lane table would move the
 * duct axis down 100 mm (the sprinkler band now sits ABOVE the ducts, where NFPA 13 wants it) and the pressure lane
 * out to −0.62 m, which is a wave-2 change with wave-2 tests, not a wave-1 one.
 */
import type { Segment2, Vec3 } from './types.ts';
import { EMPTY_RULE_SET } from './rules/engine.ts';
import { createProfileBook, stackProfile } from './kernel/profiles.ts';
import { LANE_OFFSETS_V1, lanePathIn } from './kernel/lanes.ts';
import { ELEMENT_SIZES } from './kernel/sizes.ts';

export { MOUNTING } from './kernel/mounting.ts';

export interface PlenumBands {
  soffitZ: number;
  /** Z of duct centreline */
  ductZ: number;
  /** Z of wet pipe centrelines (DCW/DHW/waste mains) */
  pipeZ: number;
  /** Z of sprinkler main centreline */
  sprinklerZ: number;
  /** Z of cable tray centreline */
  trayZ: number;
  /** Corridor ceiling height */
  ceilingZ: number;
  plenumDepth: number;
}

export interface LaneOffsets {
  /** Lateral offsets from the corridor centreline, positive = toward the corridor's left side */
  duct: number;
  pipe: number;
  sprinkler: number;
  tray: number;
}

/** v1 lane offsets, projected from `kernel/lanes.ts` (which is now their single owner). */
export const DEFAULT_LANES: LaneOffsets = {
  duct: LANE_OFFSETS_V1.duct,
  pipe: LANE_OFFSETS_V1.pipe,
  sprinkler: LANE_OFFSETS_V1.sprinkler,
  tray: LANE_OFFSETS_V1.tray,
};

/** v1 geometry constants, kept here (and nowhere else) so the wave-3 deletion removes them with the shim. */
const V1_DUCT_TOP_GAP = 0.05;
const V1_DUCT_HALF = 0.15;
const V1_PIPE_BELOW_DUCT = 0.25;
const V1_DUCT_MIN_ABOVE_CEILING = 0.15;
const V1_PIPE_MIN_ABOVE_CEILING = 0.05;

const BOOK = createProfileBook(EMPTY_RULE_SET);

export function plenumBands(floorToFloor: number, slabT: number, beamDepth: number, corridorCeiling: number): PlenumBands {
  const { resolved } = stackProfile({
    profile: BOOK.profile('resi-corridor'),
    storey: 'v1-shim',
    floorToFloor,
    slabTAbove: slabT,
    beamDAbove: beamDepth,
    beamDAboveUnit: beamDepth,
    transferZoneDepth: 0,
    ceilingWanted: corridorCeiling,
    rules: EMPTY_RULE_SET,
  });
  const soffitZ = resolved.soffitZ;
  const structureBottom = resolved.structureBottomZ;
  const ductZ = Math.max(structureBottom - V1_DUCT_TOP_GAP - V1_DUCT_HALF, corridorCeiling + V1_DUCT_MIN_ABOVE_CEILING);
  const pipeZ = Math.max(ductZ - V1_PIPE_BELOW_DUCT, corridorCeiling + V1_PIPE_MIN_ABOVE_CEILING);
  return {
    soffitZ,
    ductZ,
    pipeZ,
    sprinklerZ: pipeZ,
    trayZ: pipeZ,
    ceilingZ: corridorCeiling,
    plenumDepth: floorToFloor - corridorCeiling,
  };
}

/** A lane polyline (Vec3) parallel to a corridor centreline at a lateral offset and height. */
export function lanePath(centerline: Segment2[], lateral: number, z: number): Vec3[] {
  return lanePathIn(centerline, {
    id: 'v1', owner: 'mechanical', bandPurpose: 'service', offset: lateral, width: 0, minWidth: 0, height: 0,
    vAlign: 'top', allows: [], systemOrder: [], source: 'v1',
  }, z, 0);
}

/** Standard element sizes (m). `slabT` and `coreWallT` are owned by `StructuralPresize`; both go in wave 3. */
export const SIZES = {
  ...ELEMENT_SIZES,
  /** @deprecated read `ctx.presize.byStorey.get(storey).slabTAbove` */
  slabT: 0.2,
  /** @deprecated read `ctx.presize.coreWallT` */
  coreWallT: 0.25,
} as const;
