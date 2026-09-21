/**
 * The coordination kernel — barrel.
 *
 * Disciplines import from here: `createKernel` (the registry), `createProfileBook` / `stackProfile` (ceiling
 * profiles), the lane tables and allocators, the clearance/hanger/slope/trap-arm tables, `MOUNTING`,
 * `ELEMENT_SIZES`, the element classifier and `checkSupport`.
 */
export type * from './types.ts';
export { SHAFT_SYSTEM_ORDER, SHAFT_ZONE_OF, isConflict } from './types.ts';

export {
  PROFILE_DEFS, createProfileBook, stackProfile, profileIdFor, bandRuleId, clearHeightRuleId,
} from './profiles.ts';

export {
  LANE_SYSTEMS, LANE_OFFSETS_V1, LateralAllocator, StationAllocator, laneBoxes, laneOffsetProjection,
  lanePathIn, laneSetFor, laneSetIdFor, laneZ, requiredWidthOf,
} from './lanes.ts';
export type { LaneOffsetProjection, LaneSystemSlot } from './lanes.ts';

export {
  CLEARANCES, CLEAR_HEIGHTS, HANGERS, MOVE_COST, MOVE_COST_BANDS, ROUTE_HOME, SLOPES, TRAP_ARMS, TRAP_ARM_SOURCE,
  ZONE_CLEARS, clearanceBetween, hangerFor, moveCostOf, slopeFor, trapArmLimit,
} from './clearances.ts';
export type { ClearHeightSpec, ClearanceSpec, Flexibility, HangerSpec, RouteHomeSpec, SlopeStep } from './clearances.ts';

export { MOUNTING } from './mounting.ts';
export type { MountingKey } from './mounting.ts';
export { ELEMENT_SIZES } from './sizes.ts';
export type { ElementSizeKey } from './sizes.ts';

export { createKernel, PURPOSE_OF, applyFallLocal } from './registry.ts';
export {
  SHAFT_ZONE_ORDER, SHAFT_ZONE_SHARE, SYSTEM_OD, SYSTEM_OD_SOURCE, createShaftAllocator, kindOfSystem, longAxisOf,
  zoneRect,
} from './shafts.ts';
export { CHASE_FINISH, CHASE_MIN_LENGTH, chaseStations, createChaseAllocator } from './chases.ts';
export type { ChaseAllocator } from './chases.ts';
export { SLEEVE_NOMINALS, createSleeveAllocator, firestopFor, nominalSleeve } from './sleeves.ts';
export type { SleeveAllocator } from './sleeves.ts';

export {
  ELEMENT_KIND, GOVERNED_KINDS, boxInside, boxesOfElement, boxesOverlap, createBoxIndex, elementKindOf, isGoverned,
  validateElements,
} from './validate.ts';
export type { BoxIndex } from './validate.ts';

export { checkSupport } from './support.ts';
export type { SupportInput, SupportReport } from './support.ts';
