/**
 * F5c — Floor placer contract (frozen): the editable floor document.
 *
 * `FloorLayout` v2 replaces the v1 `FloorLayout` in types-internal.ts. It is a small, serialisable, storey-independent
 * description of a typical floor: strips along the corridor legs, slots (one placed module each) with stable ids and
 * resolved ports, the corridor graph, commons, the grid handshake and the mix report. `instantiateFloor` is a pure
 * function of it; `applyOverrides(base, spec.overrides)` is applied between planFloorLayout and instantiateFloor.
 *
 * Id stability: base ids are minted in a fixed traversal (bars in massing order → strips low, high, start, end → slots
 * left to right); overrides never renumber; removed slots leave holes; inserted slots derive from their anchor
 * ('S-BAR1-L-007.1'). In-unit refs are program-node refs, never minted element ids.
 */
import type { Rect, Region, Side, Vec2, RoomType } from '../../../core/types.ts';
import type { Deviation, RuleSet } from '../../../core/rules/types.ts';
import type { LayoutEdit, UnitEdit } from '../../../core/overrides.ts';
import type { ModuleCatalogue, Port, Range } from '../../../modules/types.ts';
import type { BayGrid } from '../../structure/presize.ts';
import type { CorridorGraph } from '../../site/corridor-graph.ts';
import type { SideWallSpec, CommonRoomSlot } from '../types-internal.ts';
import type { Interval } from '../bar-frame.ts';
import type { ProgramGraph } from '../program/types.ts';
import type { UnitLayout } from '../unit-layout-types.ts';

/** 'S-<barId>-<stripCode>-<nnn>' (+ '.<k>' for inserted slots) */
export type SlotId = string;
/** 'ST-<barId>-<L|H|S|E>-<n>' */
export type StripId = string;

export interface ResolvedPort extends Port {
  xy: Vec2;
  /** along-bar coordinate */
  along: number;
  wallSide: Side;
}

export type SlotKind = 'unit' | 'break' | 'common' | 'remnant' | 'core' | 'mep' | 'amenity';

export interface Slot {
  id: SlotId;
  stripId: StripId;
  kind: SlotKind;
  moduleId: string;
  mirrored: boolean;
  /** boundary rect: edges on the CENTRELINES of the bounding walls (v1 UnitSlot semantics) */
  boundary: Rect;
  accessSide: Side;
  exteriorSides: Side[];
  sides: Record<Side, SideWallSpec>;
  barId: string;
  coreId?: string;
  /** corridor leg this slot fronts (from the site corridor graph) */
  legId?: string;
  storeySpan?: string[];
  stairRect?: Rect;
  ports: ResolvedPort[];
  /** the slot's two boundaries along the bar, and whether each is a structural column line */
  partyLines: [{ at: number; column: boolean }, { at: number; column: boolean }];
  extraDoors?: { side: Side; width: number; height: number; type: 'garage' | 'building-entry' | 'exit'; offset?: number }[];
  /** room type for common/remnant/amenity slots */
  roomType?: RoomType;
  /** per-unit edits from spec.overrides resolved to this slot */
  edits?: UnitEdit[];
  deviations?: Deviation[];
  notes?: string;
}

export interface StripDef {
  id: StripId;
  barId: string;
  /** which side of the corridor / bar the strip is on */
  side: 'low' | 'high' | 'start' | 'end';
  /** along-bar interval the strip may fill */
  along: Interval;
  /** across-bar interval between the corridor face and the exterior face (wall centrelines) */
  across: Interval;
  /** net depth between wall faces — THE depth the module feasibility is evaluated at */
  netDepth: number;
  accessSide: Side;
  exteriorSides: Side[];
  legId?: string;
  /** cores, knuckles, break slots — intervals the packer must not use */
  blocked: Interval[];
}

export interface MixReport {
  requested: Record<string, number>;
  delivered: Record<string, number>;
  /** ½·Σ|delivered − requested| over templates (total variation); asserted ≤ 0.08 */
  deviation: number;
  byTemplate: Record<string, { requested: number; delivered: number }>;
}

export interface FloorLayout {
  version: 2;
  /** typical-floor identity (the v1 planKey) — the override propagation key */
  key: string;
  /** key + '#' + hashEdits(edits for this key) — the cache identity */
  layoutKey: string;
  strips: StripDef[];
  slots: Slot[];
  corridor: CorridorGraph | null;
  commons: CommonRoomSlot[];
  grid: { module: number; bay: Range; lines: Record<string, number[]> };
  mix: MixReport;
  blocked: Record<string, Interval[]>;
  remnantArea: number;
  deviations: Deviation[];
}

/** Context the clamp functions and the editor share (the SAME functions applyOverrides calls) */
export interface ClampCtx {
  catalogue: ModuleCatalogue;
  grid: BayGrid;
  rules: RuleSet;
  region: Region;
  level: number;
}

/** Total, pure, idempotent: never throws; `range` is the admissible closed interval of the edit's scalar */
export interface ClampResult<E> {
  edit: E;
  ok: boolean;
  reason?: string;
  range?: [number, number];
}

export type ClampLayoutEditFn = (layout: FloorLayout, edit: LayoutEdit, ctx: ClampCtx) => ClampResult<LayoutEdit>;
export type ClampUnitEditFn = (unitLayout: UnitLayout, edit: UnitEdit, program: ProgramGraph, ctx: ClampCtx) => ClampResult<UnitEdit>;
