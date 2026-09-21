/**
 * F5b — Module ("lego") catalogue contract (frozen).
 *
 * Prebuilt, pre-validated components with a fixed geometry interface and typed PORTS. Unit modules derive their
 * elastic frontage range from their program graph (never declared by hand); cores carry the three purpose-tagged
 * shaft slots; break modules split corridors; MEP-room modules carry placement constraints. Ids:
 *   unit U-<templateId>-<variant> · core C-<stair>[-lift<n>] · break K-<role> · corridor X-<width×100> ·
 *   amenity A-<role> · mep M-<role> · parking P-<role>[-<angle>]
 * `mirrored` is an INSTANCE property (Slot.mirrored) — mirroring is u → 1 − u on the frozen shape.
 */
import type { Region, RoomType, ShaftDef, Side, TypologyId, UnitTemplateId } from '../core/types.ts';
import type { Feasibility, FeasibilityOpts, PlanShape, Range } from '../disciplines/architecture/program/types.ts';

export type { Range } from '../disciplines/architecture/program/types.ts';

export type ModuleKind = 'unit' | 'core' | 'corridor' | 'break' | 'amenity' | 'mep' | 'parking';

export type PortKind =
  | 'entry' | 'stack' | 'party-line' | 'exhaust' | 'panel' | 'balcony'
  | 'shaft' | 'riser' | 'corridor-connect' | 'ramp' | 'daylight' | 'exit';

export interface Port {
  id: string;
  kind: PortKind;
  /** module-local side: 'front' = access side, u runs along it, v goes inward */
  side: Side | 'interior';
  /** position along that side as a FRACTION of its length (mirroring maps f → 1 − f) */
  atFrac: number;
  /** clear length the port needs along the side (m); 0 = point port */
  width: number;
  purpose?: ShaftDef['purpose'];
  required: boolean;
}

export interface ModuleBase {
  id: string;
  kind: ModuleKind;
  name: string;
  /** envelope of the admissible region — the first-pass filter; the exact test is catalogue.frontageAt */
  frontage: Range;
  depth: Range;
  ports: Port[];
  mirrorable: boolean;
  patterns: string[];
}

export type UnitVariant = 'single' | 'dual' | 'corner' | 'end' | 'cluster' | 'dual-key';

export interface UnitModule extends ModuleBase {
  kind: 'unit';
  templateId: UnitTemplateId;
  variant: UnitVariant;
  programId: string;
  /** the FROZEN plan shape: plan type is module identity, not a runtime guess */
  shape: PlanShape;
  levels: 1 | 2 | 3;
  areaTarget: number;
  bedrooms: number;
  bathrooms: number;
  occupants: number;
  /** what the placer must give it */
  needs: { exteriorSides: Side[]; minExteriorCount: number; endOfBar: boolean };
}

export type StairConfig = 'single' | 'dog-leg' | 'scissor';

export interface CoreModule extends ModuleBase {
  kind: 'core';
  stair: StairConfig;
  stairCount: 1 | 2;
  lifts: number;
  /** three purpose-tagged shaft slots + trash, as fractions of the footprint */
  shaftSlots: { purpose: ShaftDef['purpose']; atFrac: number; wFrac: number; dFrac: number }[];
  lobby: boolean;
  /** stair run needed across the bar = risers(f2f) × tread + landings; catalogue.coreFootprintAt resolves it */
  stairWidth: number;
  riserMax: number;
  treadMin: number;
  landing: number;
}

export interface CorridorModule extends ModuleBase {
  kind: 'corridor';
  width: number;
}

export type BreakRole = 'lounge' | 'lift-lobby' | 'window-bay' | 'cross-corridor' | 'exit-stair';

export interface BreakModule extends ModuleBase {
  kind: 'break';
  role: BreakRole;
  /** resets the ARC-03 leg counter / counts as an exit / needs a façade */
  resetsLeg: boolean;
  isExit: boolean;
  needsFacade: boolean;
}

export interface AmenityModule extends ModuleBase {
  kind: 'amenity';
  role: string;
  roomType: RoomType;
}

export type MEPRoomRole = 'switchroom' | 'water-entry' | 'fire-pump' | 'generator' | 'trash' | 'sump' | 'mech-room' | 'elec-room';

export interface MEPRoomModule extends ModuleBase {
  kind: 'mep';
  role: MEPRoomRole;
  roomType: RoomType;
  constraints: { streetSide?: boolean; noWetAbove?: boolean; lowestPoint?: boolean; externalDoor?: boolean; ventToOutside?: boolean };
}

export interface ParkingModule extends ModuleBase {
  kind: 'parking';
  role: 'double-loaded' | 'single-loaded' | 'ramp';
  /** 2×5.4 stalls + 6.0 aisle = 16.8 m bay across; single = 5.4 + 6.0 = 11.4 */
  bayAcross: number;
  stallPitch: number;
  aisle: number;
  rampSlope?: number;
}

export type AnyModule = UnitModule | CoreModule | CorridorModule | BreakModule | AmenityModule | MEPRoomModule | ParkingModule;

export interface StripQuery {
  netDepth: number;
  atStart: boolean;
  atEnd: boolean;
  exteriorSides: Side[];
  levels: number;
  typology: TypologyId;
  region: Region;
}

export interface ModuleCatalogue {
  all: readonly AnyModule[];
  byId(id: string): AnyModule | undefined;
  units: readonly UnitModule[];
  cores: readonly CoreModule[];
  breaks: readonly BreakModule[];
  amenities: readonly AmenityModule[];
  mep: readonly MEPRoomModule[];
  parking: readonly ParkingModule[];
  /** exact admissible frontage at a net depth; null when the depth is inadmissible. Memoised. */
  frontageAt(id: string, depth: number, o: FeasibilityOpts): Range | null;
  /** the witness for a concrete (frontage, depth) — the only way to get a layout */
  fitFor(id: string, frontage: number, depth: number, o: FeasibilityOpts): Feasibility | null;
  candidatesFor(strip: StripQuery): UnitModule[];
  /** core footprint (along × across the bar) for a floor-to-floor and lift count */
  coreFootprintAt(id: string, f2f: number): { along: number; across: number };
  /** RuleSet.hash() the catalogue was built for */
  rulesHash: string;
}

export interface SelfTestCase {
  moduleId: string;
  frontage: number;
  depth: number;
  level: number;
  exteriorSides: Side[];
  region: Region;
}
export interface SelfTestFailure { case: SelfTestCase; check: string; detail: string; }
