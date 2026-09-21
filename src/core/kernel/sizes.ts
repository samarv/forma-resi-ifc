/**
 * Standard architectural element sizes (m).
 *
 * This is the old `coordination.ts` `SIZES` table **minus `slabT` and `coreWallT`**: those two are structural facts
 * with exactly one owner, `StructuralPresize` (`byStorey.get(s).slabTAbove` and `presize.coreWallT`). The shim in
 * `core/coordination.ts` still exposes them until wave 3 so architecture/structure can migrate one file at a time.
 */
export const ELEMENT_SIZES = {
  exteriorWallT: 0.3,
  partyWallT: 0.25,
  corridorWallT: 0.2,
  partitionT: 0.12,
  wetWallT: 0.2,
  shaftWallT: 0.15,
  doorInterior: 0.8,
  doorBathroom: 0.75,
  doorUnitEntry: 0.9,
  doorBuildingEntry: 1.8,
  doorHeight: 2.1,
  windowHeight: 1.4,
  windowSill: 0.9,
  stairWidth: 1.1,
  stairRiserMax: 0.18,
  stairTreadMin: 0.28,
  elevatorCarW: 1.6,
  elevatorCarD: 1.5,
  elevatorShaftW: 2.0,
  elevatorShaftD: 2.2,
  parkingStallW: 2.6,
  parkingStallL: 5.4,
  parkingAisleW: 6.0,
  accessibleStallW: 3.6,
} as const;

export type ElementSizeKey = keyof typeof ELEMENT_SIZES;

/** The two keys that moved to `StructuralPresize`; kept here only so the shim and the wave-3 deletion agree. */
export const PRESIZE_OWNED_SIZES = ['slabT', 'coreWallT'] as const;
