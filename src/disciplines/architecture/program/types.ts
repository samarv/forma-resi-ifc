/**
 * F5a — Program graphs, feasibility witnesses and unit ports (frozen).
 *
 * A template is a PROGRAM GRAPH: rooms as nodes with size ranges (derived from their furniture kits), required and
 * forbidden adjacencies, zone ordering and wet groups. A layout can only be produced by passing a `Feasibility`
 * witness — the solver's proof that a (frontage, depth) admits the program — so "too small for the template" cannot
 * occur downstream. Modules declare their admissible frontage range from this witness, and their PORTS (stack,
 * exhaust, panel) as fractions of frontage so identical modules stack vertically.
 */
import type { Rect, Region, RoomType, Side, UnitTemplateId, Vec2, Zone } from '../../../core/types.ts';

/** '<roomType><n>' — e.g. 'bedroom2', 'kitchen1'. Stable across regenerations; used by editor overrides. */
export type NodeRef = string;

export interface Range { min: number; max: number }

export type KitId =
  | 'living-3seat' | 'living-compact' | 'living-kitchen' | 'dining-4' | 'dining-6'
  | 'kitchen-galley' | 'kitchen-galley-washer' | 'kitchen-island' | 'kitchen-accessible'
  | 'bed-double' | 'bed-single' | 'bed-master' | 'bed-bunk' | 'bath-3pc-tub' | 'bath-3pc-shower'
  | 'bath-accessible' | 'wc-2pc' | 'laundry-stack' | 'laundry-side' | 'shelf' | 'wardrobe-run'
  | 'entry' | 'desk' | 'garage-1car' | 'balcony-2' | 'shared-living' | 'shared-kitchen' | 'none';

export type ProgramBand = 'daylit' | 'service' | 'circulation';

export interface ProgramNode {
  ref: NodeRef;
  type: RoomType;
  zone: Zone;
  level: number;
  area: { min: number; target: number; max: number };
  /** clear internal dims; min* are ASSERTED ≥ kitMinDims(kit) at build time */
  minWidth: number;
  minDepth: number;
  maxWidth: number;
  maxDepth: number;
  aspect: Range;
  needsExterior: boolean;
  wet: boolean;
  kit: KitId;
  /** may sit in a second row behind a wet/service column when the band is deep enough */
  stackable: boolean;
  /** declared alternative: becomes furniture in another room instead of a room (NOT a dropped room) */
  mergeInto?: { ref: NodeRef; kit: KitId };
  band: ProgramBand;
}

export type AdjacencyKind = 'share-edge' | 'door' | 'no-door' | 'not-adjacent';

export interface AdjacencyRule {
  a: NodeRef | RoomType;
  b: NodeRef | RoomType;
  kind: AdjacencyKind;
  regions?: Region[];
  reason: string;
}

export interface ProgramGraph {
  id: string;
  templateId: UnitTemplateId;
  levels: number;
  nodes: ProgramNode[];
  rules: AdjacencyRule[];
  /** v order from the access side; each entry is the set of zones allowed in that band */
  zoneOrder: Zone[][];
  wetGroups: NodeRef[][];
  maxStacks: 1 | 2;
}

export interface BandSpec {
  /** columns along the band's slicing axis; each column is a stack of nodes along the band's depth axis */
  columns: NodeRef[][];
  depth: Range;
  daylit: boolean;
}

export type PlanShapeType = 'zoned' | 'house' | 'through' | 'cluster' | 'dual-key';

export interface PlanShape {
  type: PlanShapeType;
  /** full-depth column at u = 0 (stair, entry spine, garage) */
  spine?: { nodes: NodeRef[]; width: Range };
  /** in v order from the access side */
  bands: BandSpec[];
  /** true → bands run along u and are sliced in v (the through plan is the transpose) */
  transpose: boolean;
  level: number;
}

export interface FeasibilityOpts {
  region: Region;
  accessible?: boolean;
  levels?: number;
  detail?: 'low' | 'medium' | 'high';
  /** RuleSet.hash() — feasibility depends on rule parameters (kit clearances, leaf minima) */
  rulesHash?: string;
}

/** The witness: proof that the program fits (frontage, depth) with these band depths and node width bounds */
export interface Feasibility {
  ok: true;
  programId: string;
  shape: PlanShape;
  frontage: Range;
  depth: number;
  bandDepths: number[];
  widths: Record<NodeRef, Range>;
  /** program alternatives applied to make it fit — recorded, never warned */
  merged: { ref: NodeRef; into: NodeRef }[];
  stacked: NodeRef[];
  /** Room rects in the unit-local frame (u along the frontage from 0, v inward from the access side) — lets the editor draw module thumbnails without running the solver */
  rooms?: { ref: NodeRef; type: RoomType; zone: Zone; rect: Rect }[];
}

export interface Infeasible { ok: false; reason: string; shortBy?: number }
export type FeasibilityResult = Feasibility | Infeasible;

// ---------------------------------------------------------------------------------------------------------------
// Ports — persisted on UnitLayout / UnitInstance; consumed by plumbing (chase), mechanical, electrical, the editor
// ---------------------------------------------------------------------------------------------------------------

export interface StackPort {
  /** 'stack.1' */
  id: string;
  /** world XY of the station on the wet-wall centreline */
  xy: Vec2;
  /** local u as a FRACTION of frontage — identical modules therefore stack vertically */
  atFrac: number;
  wallId: string;
  /** node refs (rooms) draining into this station */
  serves: NodeRef[];
  systems: ('waste' | 'vent' | 'dcw' | 'dhw')[];
  /** longest developed trap-arm length inside this group (m) — asserted ≤ maxTrapArm by the module self-test */
  maxArm: number;
}

export interface ExhaustPort {
  id: string;
  xy: Vec2;
  atFrac: number;
  side: Side;
  kind: 'kitchen' | 'bath' | 'dryer' | 'mvhr';
  flowLs: number;
}

export interface PanelPort {
  id: string;
  xy: Vec2;
  wallId: string;
  roomId: string;
  height: number;
}

/** The persisted room graph of a laid-out unit */
export interface ResolvedProgramGraph {
  nodes: { ref: NodeRef; roomId: string; type: RoomType }[];
  edges: { a: NodeRef; b: NodeRef; kind: 'door' | 'opening' | 'share-edge'; doorId?: string }[];
}
