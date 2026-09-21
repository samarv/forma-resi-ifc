/**
 * F1 — Rule engine + issues ledger contract (frozen).
 *
 * Every tunable in the generator is a `Rule` record (data), consumed by the generators through `RuleSet.num/table`
 * and re-checked by the validator through the closed predicate vocabulary. Structured `Issue`s replace the flat
 * `warnings: string[]`; `Ledger.warnings()` keeps a string projection during migration.
 *
 * Severities: `info` (a resolution was applied, nothing to do) · `deviation` (an explicit user override or a recorded
 * relaxation) · `violation` (a rule the generator should have satisfied — a bug; presets must have none) · `error`
 * (bad input, e.g. an invalid custom rule, dropped and reported).
 *
 * Erasable TypeScript only: no enums, no namespaces, no parameter properties.
 */
import type {
  Discipline, FloorUse, RoomType, UnitTemplateId, TypologyId, Region, BuildingSpec, TypologyDef, StoreyDef,
  SiteModel, ArchModel, StructModel, MechModel, PlumbModel, ElecModel, ModelElement, RoomDef, UnitInstance,
  FloorPlan, DoorDef, CorridorDef, Vec3,
} from '../types.ts';
import type { ElementKind, Kernel, InvertModel, Support } from '../kernel/types.ts';
import type { StructuralPresize } from '../../disciplines/structure/presize.ts';

export type Severity = 'info' | 'deviation' | 'violation' | 'error';
export type RuleKind = 'param' | 'constraint';

export interface RuleParam {
  value: number | string | boolean;
  unit?: string;
  /** Code section, design guide, Alexander pattern number, 'typology', 'spec', 'default' — never empty */
  source: string;
}

export interface RuleScope {
  floorUse?: readonly FloorUse[];
  roomType?: readonly RoomType[];
  elementKinds?: readonly ElementKind[];
  templateIds?: readonly UnitTemplateId[];
  storeys?: readonly string[];
  storeyIndexMin?: number;
  storeyIndexMax?: number;
  typologies?: readonly TypologyId[];
  regions?: readonly Region[];
  sprinklered?: boolean;
}

/** The closed predicate vocabulary. Custom rules can only compose these. */
export type PredicateId =
  | 'minDim' | 'minArea' | 'maxArea' | 'aspect'
  | 'adjacent' | 'connected' | 'notThrough'
  | 'exterior' | 'daylight'
  | 'withinDistance' | 'clearance' | 'notOver'
  | 'band' | 'lane' | 'inReservation'
  | 'maxRun' | 'deadEnd' | 'egressTravel'
  | 'supported' | 'slope' | 'continuous' | 'reaches'
  | 'clearHeight' | 'swingClear'
  | 'loadPath' | 'cappedAtDemise' | 'count' | 'ratio';

/** Named resolution strategies a generator may apply (and record as an issue) instead of warning. */
export type ResolutionId =
  | 'none' | 'clamp' | 'shift-along-lane' | 'shift-lateral' | 'compress-band' | 'drop-band'
  | 'raise-floor-to-floor' | 'lower-ceiling' | 'oversize-pipe'
  | 'add-basement-level' | 'add-podium-level' | 'relax-parking-ratio'
  | 'split-corridor' | 'add-core' | 'switch-highrise-ruleset'
  | 'add-sump' | 'vent-branch' | 'reroute-in-wall' | 'enlarge-shaft' | 'snap-to-party-line'
  | 'swap-module' | 'merge-room' | 'stack-room';

export type SubjectKind = 'building' | 'floor' | 'unit' | 'room' | 'door' | 'corridor' | 'element' | 'run' | 'support';

export interface Rule {
  /** 'ARC-03.maxLegLength', 'PLB-02.trapArm', 'STR-C1.columnContinuity', 'USR-bed-min-width' */
  id: string;
  title: string;
  discipline: Discipline | 'xd';
  patternId?: string;
  kind: RuleKind;
  scope: RuleScope;
  /** `param` rules carry a single `value`; constraint rules carry their own named parameters */
  params: Readonly<Record<string, RuleParam>>;
  predicate?: { id: PredicateId; args: readonly (string | number | boolean)[] };
  severity: Severity;
  resolution?: ResolutionId;
  rationale?: string;
  /** Predicate is evaluated once per subject of this kind */
  subject?: SubjectKind;
}

export interface Issue {
  id: string;
  severity: Severity;
  ruleId: string;
  discipline: Discipline | 'xd';
  storey?: string;
  unitId?: string;
  roomId?: string;
  elementIds?: readonly string[];
  message: string;
  observed?: number | string;
  limit?: number | string;
  source?: string;
  resolution?: { id: ResolutionId; from?: number | string; to?: number | string; note?: string };
  /** Deduplication count when added via addOnce */
  count?: number;
}

/** An issue before the ledger assigns its id (what disciplines hand up) */
export type Deviation = Omit<Issue, 'id'>;

export interface Ledger {
  add(i: Deviation): Issue;
  /** Deduplicate by key; increments `count` on the first issue and returns null */
  addOnce(key: string, i: Deviation): Issue | null;
  all(): readonly Issue[];
  bySeverity(s: Severity): readonly Issue[];
  byRule(ruleId: string): readonly Issue[];
  counts(): Record<Severity, number>;
  /** Back-compat projection: the strings DesignModel.warnings / the CLI / the app still read (info excluded by default) */
  warnings(o?: { includeInfo?: boolean }): string[];
}

export interface ScopeContext {
  floorUse?: FloorUse;
  roomType?: RoomType;
  elementKind?: ElementKind;
  templateId?: UnitTemplateId;
  storey?: string;
  storeyIndex?: number;
  typology?: TypologyId;
  region?: Region;
  sprinklered?: boolean;
}

export interface RuleSet {
  all(): readonly Rule[];
  get(id: string): Rule | null;
  /** Reads `params.value` of a `param` rule (or `params[name]` when id is 'RULE.name'); fallback when absent/disabled */
  num(id: string, fallback: number): number;
  str(id: string, fallback: string): string;
  bool(id: string, fallback: boolean): boolean;
  /** Stepped tables, e.g. PLB-02.trapArm → [[0.032, 1.07], [0.04, 1.52], [0.05, 1.83], [0.075, 3.05], [0.1, 3.66]] */
  table(id: string): readonly [number, number][];
  /** Rules whose scope matches a subject, in canonical id order */
  forSubject(kind: SubjectKind, ctx: ScopeContext): readonly Rule[];
  disabled(id: string): boolean;
  profileApplied(name: string): boolean;
  /** Stable hash of the resolved rule set — memo key for anything derived from rules (e.g. the module catalogue) */
  hash(): string;
}

export interface RunSubject {
  kind: 'run';
  id: string;
  storey: string;
  system: string;
  path: readonly Vec3[];
  diameter: number;
}

export type Subject =
  | { kind: 'building' }
  | { kind: 'floor'; floor: FloorPlan }
  | { kind: 'unit'; unit: UnitInstance }
  | { kind: 'room'; room: RoomDef }
  | { kind: 'door'; door: DoorDef }
  | { kind: 'corridor'; corridor: CorridorDef }
  | { kind: 'element'; element: ModelElement }
  | RunSubject
  | { kind: 'support'; support: Support };

/** Persisted room adjacency/connectivity graph (today discarded after doors are cut) */
export interface RoomGraph {
  /** rooms sharing a wall */
  adjacent(roomId: string): readonly string[];
  /** rooms sharing a door / cased opening */
  connected(roomId: string): readonly string[];
  path(a: string, b: string): readonly string[] | null;
  /** rooms one must pass through to get from a to b (excluding a and b) */
  through(a: string, b: string): readonly string[];
}

export interface World {
  spec: BuildingSpec;
  typology: TypologyDef;
  storeys: readonly StoreyDef[];
  site: SiteModel;
  arch: ArchModel | null;
  struct: StructModel | null;
  mech: MechModel | null;
  plumb: PlumbModel | null;
  elec: ElecModel | null;
  presize: StructuralPresize | null;
  kernel: Kernel | null;
  graph: RoomGraph;
  invert: InvertModel | null;
  elementById: Map<string, ModelElement>;
  roomById: Map<string, RoomDef>;
}

export interface PredicateResult { ok: boolean; observed?: number | string; limit?: number | string; detail?: string; }
export type Predicate = (w: World, rule: Rule, s: Subject) => PredicateResult;

/** Drives the rule-builder UI: which subjects/objects/limit types a predicate accepts */
export interface PredicateSignature {
  subjects: readonly SubjectKind[];
  object?: readonly ('roomType' | 'elementKind' | 'system' | 'none')[];
  limitType: 'number' | 'string' | 'boolean';
  unit?: string;
  description: string;
  resolutions?: readonly ResolutionId[];
}

// ---------------------------------------------------------------------------------------------------------------
// Custom rules in the spec (spec.rules) — JSON-serialisable, deterministic, shareable
// ---------------------------------------------------------------------------------------------------------------

export type SubjectSelector =
  | { kind: 'room'; roomType?: string[]; zone?: string[] }
  | { kind: 'unit'; templateId?: string[] }
  | { kind: 'floor'; floorUse?: string[] }
  | { kind: 'corridor' }
  | { kind: 'door'; doorType?: string[] }
  | { kind: 'element'; elementKind?: string[] }
  | { kind: 'run'; system?: string[] }
  | { kind: 'support' }
  | { kind: 'building' };

export type ObjectSelector =
  | { kind: 'roomType'; value: string }
  | { kind: 'elementKind'; value: string }
  | { kind: 'system'; value: string }
  | { kind: 'none' };

export type LimitOp = '>=' | '<=' | '==' | '!=';

export interface CustomRule {
  /** must match /^USR-[A-Za-z0-9_-]{1,32}$/ and be unique */
  id: string;
  title: string;
  subject: SubjectSelector;
  predicate: PredicateId;
  object?: ObjectSelector;
  limit: { op: LimitOp; value: number | string | boolean; unit?: string };
  scope?: RuleScope;
  severity?: Severity;
  resolution?: ResolutionId;
  source?: string;
}

export interface RuleOverrides {
  version: 1;
  /** ruleId → paramName → value */
  params?: Record<string, Record<string, number | string | boolean>>;
  severity?: Record<string, Severity>;
  disabled?: string[];
  custom?: CustomRule[];
  /** Named rule profiles layered on top, e.g. 'high-rise', 'sprinklered', 'uk' */
  profiles?: string[];
}
