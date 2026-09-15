/**
 * DesignModel → IFC STEP file.
 *
 * The writer is the ONLY place that knows about IfcCreator. It maps every
 * `ModelElement.geometry.kind` to the right constructor (table in CONTRACT.md),
 * attaches property sets / quantities / materials / colours, and groups MEP
 * elements into IfcDistributionSystems and dwelling spaces into IfcZones.
 *
 * Contracts the discipline modules must respect
 * -------------------------------------------------
 * - Element Z is STOREY-LOCAL. The writer passes coordinates through unchanged;
 *   `StoreyDef.elevation` is applied once by the storey's own placement.
 * - `door-in-wall` / `window-in-wall` `hostId` MUST be the id of an element whose
 *   geometry kind is `wall` (any discipline). Unresolvable hosts degrade to a
 *   standalone IfcDoor/IfcWindow plus a warning.
 * - `box.position` is the corner at the box's LOCAL origin; the box rotates about
 *   that corner (identical semantics to IfcFurnishingElement).
 * - `slab.profile` / `prism.profile` points are RELATIVE to `position`.
 * - A wall may either carry `geometry.openings` OR host `door-in-wall` /
 *   `window-in-wall` elements (which cut their own openings) — doing both cuts
 *   the same hole twice.
 * - Every element id lands in the IFC file as the product's `Tag`, so ids survive
 *   a round trip. IfcSpace has no Tag attribute: its id goes into `Description`.
 *
 * Robustness: every element write is wrapped in try/catch. One bad element yields
 * a warning (`writer: <id> (<kind>): <message>`) and never aborts the file.
 *
 * File size
 * ---------
 * A mid-rise with MEP is ~30 000 ModelElements, and a naive writer spends ~36
 * STEP entities on each of them. Two things keep that near 11:
 * - Property and quantity sets are SHARED. Every element's sets are
 *   canonicalised (name + properties sorted by name) and collected; identical
 *   sets are written once and bound to every product that carries them with
 *   one IfcRelDefinesByProperties per 250 products. See {@link SharedSets}.
 * - The vendored creator caches the immutable geometry resources
 *   (IfcCartesianPoint, IfcDirection, IfcAxis2Placement2D/3D, parametric
 *   profiles), so repeated values cost one entity instead of thousands.
 * Neither changes what a reader sees: same products, same property values,
 * same colours, same containment and grouping. `opts.compact` (default on)
 * additionally trims the per-element metadata that cannot be shared.
 */
import type {
  DesignModel, ElementGeometry, IfcOutput, ModelElement, PropertySetDef,
  RectangularOpeningDef, StoreyDef, Vec2, Vec3,
} from '../core/types.ts';
import { createRng } from '../core/rng.ts';
import { IfcCreator } from './vendor/ifc-lite-create/ifc-creator.ts';
import { generateIfcGuid } from './vendor/ifc-lite-create/guid.ts';
import type {
  GableRoofParams, Point2D, Point3D, ProfileDef, RectangularOpening,
  PropertySetDef as CreatorPropertySet, QuantitySetDef as CreatorQuantitySet,
  MaterialDef as CreatorMaterial, PropertyType,
} from './vendor/ifc-lite-create/types.ts';

export interface WriteIfcOptions {
  /** Defaults to `model.spec.options.ifcSchema`. */
  schema?: 'IFC2X3' | 'IFC4' | 'IFC4X3';
  author?: string;
  /**
   * Byte-reproducible output: GlobalIds come from a generator seeded with
   * `spec.seed` and the header/owner-history timestamp is fixed. Default true —
   * pass `false` for globally unique GlobalIds and a wall-clock timestamp.
   */
  deterministic?: boolean;
  /**
   * Trim the per-element metadata that cannot be shared between products.
   * Defaults to `true` unless `spec.options.detail === 'high'`.
   *
   * Compact mode:
   * - `Forma_Common` carries only `Discipline`, `Storey`, `System` and
   *   `Patterns` — the class-level facts. `ElementId` is dropped because it is
   *   already the product's `Tag` (IfcSpace: `Description`), and `UnitId` /
   *   `RoomId` are dropped because they make the pset unique per element,
   *   which defeats sharing for the sake of data the `IfcZone` per dwelling
   *   and the space containment already carry.
   * - `quantities` are written only for IfcSpace and IfcSlab (the two things
   *   an area/volume take-off actually reads); every other element's
   *   quantities are derivable from its geometry.
   *
   * Full mode (`compact: false`, or `detail: 'high'`) writes every property
   * set and quantity set of every element, as the writer always did.
   *
   * Property sets are shared between products in BOTH modes: identical sets
   * are written once and bound to every product that carries them.
   */
  compact?: boolean;
}

/** Fixed creation instant used in deterministic mode (2024-01-01T12:00:00Z). */
export const DETERMINISTIC_TIMESTAMP_MS = Date.UTC(2024, 0, 1, 12, 0, 0);

/** Lengths below this are treated as degenerate (zero-length axis). */
const MIN_LENGTH = 1e-4;

/** Upper bound on collected warnings, so one broken discipline cannot flood the report. */
const MAX_WARNINGS = 500;

// ============================================================================
// MEP system → IfcDistributionSystemEnum
// ============================================================================

/**
 * `system` id suffix → IFC4 `IfcDistributionSystemEnum` + human label.
 *
 * System ids follow `SYS-<DISC>-<NAME>` (core/ids.ts `systemId()`); the lookup
 * strips the `SYS-<DISC>-` prefix and matches the remainder, then the last
 * segment, then falls back to USERDEFINED.
 */
export const SYSTEM_TYPES: Record<string, { type: string; label: string }> = {
  // Mechanical — air
  'SUPPLY': { type: 'AIRCONDITIONING', label: 'Supply air' },
  'SUPPLY-AIR': { type: 'AIRCONDITIONING', label: 'Supply air' },
  'RETURN': { type: 'AIRCONDITIONING', label: 'Return air' },
  'RETURN-AIR': { type: 'AIRCONDITIONING', label: 'Return air' },
  'EXHAUST': { type: 'EXHAUST', label: 'Exhaust air' },
  'KITCHEN-EXHAUST': { type: 'EXHAUST', label: 'Kitchen exhaust' },
  'DRYER-EXHAUST': { type: 'EXHAUST', label: 'Dryer exhaust' },
  'OUTDOOR-AIR': { type: 'VENTILATION', label: 'Outdoor air' },
  'OA': { type: 'VENTILATION', label: 'Outdoor air' },
  'FRESH-AIR': { type: 'VENTILATION', label: 'Fresh air' },
  'VENTILATION': { type: 'VENTILATION', label: 'Ventilation' },
  'MVHR': { type: 'VENTILATION', label: 'MVHR' },
  'ERV': { type: 'VENTILATION', label: 'ERV' },
  'DOAS': { type: 'VENTILATION', label: 'Dedicated outdoor air' },
  'CORRIDOR-PRESSURIZATION': { type: 'VENTILATION', label: 'Corridor pressurisation' },
  // Mechanical — wet / refrigerant
  'REFRIGERANT': { type: 'REFRIGERATION', label: 'Refrigerant' },
  'HYDRONIC': { type: 'HEATING', label: 'Hydronic heating' },
  'HEATING': { type: 'HEATING', label: 'Heating' },
  'LTHW': { type: 'HEATING', label: 'Low temperature hot water' },
  'CHILLED-WATER': { type: 'CHILLEDWATER', label: 'Chilled water' },
  'CHW': { type: 'CHILLEDWATER', label: 'Chilled water' },
  'COOLING': { type: 'CHILLEDWATER', label: 'Cooling' },
  'CONDENSER-WATER': { type: 'CONDENSERWATER', label: 'Condenser water' },
  // Plumbing
  'DCW': { type: 'DOMESTICCOLDWATER', label: 'Domestic cold water' },
  'COLD-WATER': { type: 'DOMESTICCOLDWATER', label: 'Domestic cold water' },
  'WATER': { type: 'DOMESTICCOLDWATER', label: 'Water supply' },
  'DHW': { type: 'DOMESTICHOTWATER', label: 'Domestic hot water' },
  'HOT-WATER': { type: 'DOMESTICHOTWATER', label: 'Domestic hot water' },
  'HWR': { type: 'DOMESTICHOTWATER', label: 'Hot water return' },
  'RECIRC': { type: 'DOMESTICHOTWATER', label: 'Hot water recirculation' },
  'WASTE': { type: 'WASTEWATER', label: 'Waste / soil' },
  'SOIL': { type: 'WASTEWATER', label: 'Soil' },
  'SANITARY': { type: 'WASTEWATER', label: 'Sanitary drainage' },
  'DRAINAGE': { type: 'DRAINAGE', label: 'Drainage' },
  'VENT': { type: 'VENT', label: 'Sanitary vent' },
  'STORM': { type: 'RAINWATER', label: 'Storm / rainwater' },
  'RAINWATER': { type: 'RAINWATER', label: 'Rainwater' },
  'ROOF-DRAIN': { type: 'RAINWATER', label: 'Roof drainage' },
  'SPRINKLER': { type: 'FIREPROTECTION', label: 'Sprinkler' },
  'STANDPIPE': { type: 'FIREPROTECTION', label: 'Standpipe' },
  'FIRE': { type: 'FIREPROTECTION', label: 'Fire protection' },
  'GAS': { type: 'GAS', label: 'Gas' },
  // Electrical
  'POWER': { type: 'ELECTRICAL', label: 'Power' },
  'ELECTRICAL': { type: 'ELECTRICAL', label: 'Electrical' },
  'NORMAL-POWER': { type: 'ELECTRICAL', label: 'Normal power' },
  'EV': { type: 'ELECTRICAL', label: 'EV charging' },
  'LIGHTING': { type: 'LIGHTING', label: 'Lighting' },
  'HOUSE-LIGHTING': { type: 'LIGHTING', label: 'House lighting' },
  'DATA': { type: 'DATA', label: 'Data' },
  'COMMS': { type: 'COMMUNICATION', label: 'Communications' },
  'LIFE-SAFETY': { type: 'FIREPROTECTION', label: 'Life safety' },
  'FIRE-ALARM': { type: 'FIREPROTECTION', label: 'Fire alarm' },
  'PV': { type: 'POWERGENERATION', label: 'Photovoltaic' },
  'SOLAR': { type: 'POWERGENERATION', label: 'Solar' },
  'GENERATOR': { type: 'POWERGENERATION', label: 'Standby generation' },
  // Other
  'TRASH': { type: 'MUNICIPALSOLIDWASTE', label: 'Refuse' },
  'REFUSE': { type: 'MUNICIPALSOLIDWASTE', label: 'Refuse' },
};

/** Resolve a `system` id to an IfcDistributionSystemEnum token + label. */
export function systemClassification(systemId: string): { type: string; label: string } {
  const key = systemId.toUpperCase().replace(/^SYS-[A-Z]{3}-/, '');
  const exact = SYSTEM_TYPES[key];
  if (exact) return exact;
  const last = key.split('-').pop() ?? key;
  const tail = SYSTEM_TYPES[last];
  if (tail) return tail;
  return { type: 'USERDEFINED', label: systemId };
}

/**
 * IFC4-only entity names down-mapped for IFC2X3 output. IFC2X3 has no
 * IfcPipeSegment/IfcOutlet/… — the generic IfcFlow* families are its equivalent.
 */
const IFC2X3_TYPE_FALLBACKS: Record<string, string> = {
  IFCPIPESEGMENT: 'IFCFLOWSEGMENT',
  IFCDUCTSEGMENT: 'IFCFLOWSEGMENT',
  IFCCABLECARRIERSEGMENT: 'IFCFLOWSEGMENT',
  IFCCABLESEGMENT: 'IFCFLOWSEGMENT',
  IFCPIPEFITTING: 'IFCFLOWFITTING',
  IFCDUCTFITTING: 'IFCFLOWFITTING',
  IFCCABLECARRIERFITTING: 'IFCFLOWFITTING',
  IFCJUNCTIONBOX: 'IFCFLOWFITTING',
  IFCAIRTERMINAL: 'IFCFLOWTERMINAL',
  IFCSANITARYTERMINAL: 'IFCFLOWTERMINAL',
  IFCFIRESUPPRESSIONTERMINAL: 'IFCFLOWTERMINAL',
  IFCLIGHTFIXTURE: 'IFCFLOWTERMINAL',
  IFCOUTLET: 'IFCFLOWTERMINAL',
  IFCSWITCHINGDEVICE: 'IFCFLOWCONTROLLER',
  IFCVALVE: 'IFCFLOWCONTROLLER',
  IFCDAMPER: 'IFCFLOWCONTROLLER',
  IFCELECTRICDISTRIBUTIONBOARD: 'IFCFLOWCONTROLLER',
  IFCPROTECTIVEDEVICE: 'IFCFLOWCONTROLLER',
  IFCUNITARYEQUIPMENT: 'IFCENERGYCONVERSIONDEVICE',
  IFCBOILER: 'IFCENERGYCONVERSIONDEVICE',
  IFCCHILLER: 'IFCENERGYCONVERSIONDEVICE',
  IFCCOIL: 'IFCENERGYCONVERSIONDEVICE',
  IFCSOLARDEVICE: 'IFCENERGYCONVERSIONDEVICE',
  IFCTRANSFORMER: 'IFCENERGYCONVERSIONDEVICE',
  IFCFAN: 'IFCFLOWMOVINGDEVICE',
  IFCPUMP: 'IFCFLOWMOVINGDEVICE',
  IFCTANK: 'IFCFLOWSTORAGEDEVICE',
  IFCSENSOR: 'IFCDISTRIBUTIONCONTROLELEMENT',
  IFCALARM: 'IFCDISTRIBUTIONCONTROLELEMENT',
  IFCCONTROLLER: 'IFCDISTRIBUTIONCONTROLELEMENT',
  IFCACTUATOR: 'IFCDISTRIBUTIONCONTROLELEMENT',
  IFCGEOGRAPHICELEMENT: 'IFCBUILDINGELEMENTPROXY',
  IFCSHADINGDEVICE: 'IFCBUILDINGELEMENTPROXY',
  IFCCHIMNEY: 'IFCBUILDINGELEMENTPROXY',
  IFCDOORSTANDARDCASE: 'IFCDOOR',
  IFCWINDOWSTANDARDCASE: 'IFCWINDOW',
};

/** IfcWallTypeEnum, IFC4 (IFC4X3 adds RETAININGWALL, which IFC4 readers reject). */
const WALL_TYPES = new Set([
  'MOVABLE', 'PARAPET', 'PARTITIONING', 'PLUMBINGWALL', 'SHEAR', 'SOLIDWALL', 'STANDARD',
  'POLYGONAL', 'ELEMENTEDWALL', 'USERDEFINED', 'NOTDEFINED',
]);
const SLAB_TYPES = new Set(['FLOOR', 'ROOF', 'LANDING', 'BASESLAB', 'USERDEFINED', 'NOTDEFINED']);
const RAILING_TYPES = new Set(['HANDRAIL', 'GUARDRAIL', 'BALUSTRADE', 'USERDEFINED', 'NOTDEFINED']);
const ROOF_TYPES = new Set([
  'FLAT_ROOF', 'SHED_ROOF', 'GABLE_ROOF', 'HIP_ROOF', 'HIPPED_GABLE_ROOF', 'GAMBREL_ROOF',
  'MANSARD_ROOF', 'BARREL_ROOF', 'RAINBOW_ROOF', 'BUTTERFLY_ROOF', 'PAVILION_ROOF',
  'DOME_ROOF', 'FREEFORM', 'USERDEFINED', 'NOTDEFINED',
]);
const SPACE_TYPES = new Set(['SPACE', 'PARKING', 'GFA', 'INTERNAL', 'EXTERNAL', 'USERDEFINED', 'NOTDEFINED']);
const PILE_TYPES = new Set(['BORED', 'DRIVEN', 'JETGROUTING', 'COHESION', 'FRICTION', 'SUPPORT', 'USERDEFINED', 'NOTDEFINED']);
const DOOR_TYPES = new Set(['DOOR', 'GATE', 'TRAPDOOR', 'USERDEFINED', 'NOTDEFINED']);
const DOOR_OPERATIONS = new Set([
  'SINGLE_SWING_LEFT', 'SINGLE_SWING_RIGHT', 'DOUBLE_DOOR_SINGLE_SWING',
  'DOUBLE_DOOR_SINGLE_SWING_OPPOSITE_LEFT', 'DOUBLE_DOOR_SINGLE_SWING_OPPOSITE_RIGHT',
  'DOUBLE_SWING_LEFT', 'DOUBLE_SWING_RIGHT', 'DOUBLE_DOOR_DOUBLE_SWING', 'SLIDING_TO_LEFT',
  'SLIDING_TO_RIGHT', 'DOUBLE_DOOR_SLIDING', 'FOLDING_TO_LEFT', 'FOLDING_TO_RIGHT',
  'DOUBLE_DOOR_FOLDING', 'REVOLVING', 'ROLLINGUP', 'SWING_FIXED_LEFT', 'SWING_FIXED_RIGHT',
  'USERDEFINED', 'NOTDEFINED',
]);
const WINDOW_PARTITIONS = new Set([
  'SINGLE_PANEL', 'DOUBLE_PANEL_HORIZONTAL', 'DOUBLE_PANEL_VERTICAL',
  'TRIPLE_PANEL_HORIZONTAL', 'NOTDEFINED',
]);

// ============================================================================
// Pure geometry helpers (exported for tests)
// ============================================================================

/**
 * Placement for a `box`: the profile is centred by `addRectangleProfile`, so the
 * location is pushed to the box centre while `position` stays the corner at the
 * box's local origin. Identical to what `addIfcFurnishingElement` does internally.
 */
export function boxPlacement(
  position: Vec3, width: number, depth: number, rotation = 0,
): { location: Point3D; refDirection: Point3D } {
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  return {
    location: [
      position[0] + (width / 2) * c - (depth / 2) * s,
      position[1] + (width / 2) * s + (depth / 2) * c,
      position[2],
    ],
    refDirection: [c, s, 0],
  };
}

/**
 * World-space footprint corners of a `box`, starting at `position` (the local
 * origin corner) and running local (w,0) → (w,d) → (0,d).
 */
export function boxFootprint(position: Vec3, width: number, depth: number, rotation = 0): Vec2[] {
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  const local: Vec2[] = [[0, 0], [width, 0], [width, depth], [0, depth]];
  return local.map(([lx, ly]) => [
    position[0] + lx * c - ly * s,
    position[1] + lx * s + ly * c,
  ] as Vec2);
}

/** Axis-aligned bounds of a relative profile, used to fill Width/Depth for profile-based params. */
function profileBounds(profile: Vec2[]): { w: number; d: number } {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const [x, y] of profile) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { w: Math.max(maxX - minX, MIN_LENGTH), d: Math.max(maxY - minY, MIN_LENGTH) };
}

function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

/** Deep finiteness check — catches NaN/Infinity anywhere in a geometry record. */
export function allNumbersFinite(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(allNumbersFinite);
  if (value !== null && typeof value === 'object') return Object.values(value).every(allNumbersFinite);
  return true;
}

function positive(...values: number[]): boolean {
  return values.every(v => Number.isFinite(v) && v > 0);
}

/** Uppercase + sanitise a predefined-type token for STEP (`.TOKEN.`). */
function enumToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const token = value.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  return token.length > 0 ? token : undefined;
}

function pick(set: Set<string>, value: string | undefined, fallback: string): string {
  const token = enumToken(value);
  return token !== undefined && set.has(token) ? token : fallback;
}

// ============================================================================
// writeIfc
// ============================================================================

export function writeIfc(model: DesignModel, opts: WriteIfcOptions = {}): IfcOutput {
  const warnings: string[] = [];
  let suppressed = 0;
  const warn = (message: string): void => {
    if (warnings.length < MAX_WARNINGS) warnings.push(message);
    else suppressed += 1;
  };

  const schema = opts.schema ?? model.spec.options?.ifcSchema ?? 'IFC4';
  const deterministic = opts.deterministic !== false;
  const compact = opts.compact ?? model.spec.options?.detail !== 'high';
  const guidRng = createRng(`${model.spec.name}:${model.spec.seed}:ifc-guid`);

  const creator = new IfcCreator({
    Name: model.spec.name,
    Description: `${model.typology?.name ?? model.spec.typology} generated by forma-resi-ifc`,
    Schema: schema,
    Author: opts.author ?? 'forma-resi-ifc',
    Organization: 'forma-resi-ifc',
    FileName: `${model.spec.name}.ifc`,
    FileDescription: `ViewDefinition [CoordinationView]`,
    Site: {
      Name: `${model.spec.name} Site`,
      Description: `${model.spec.site.width} × ${model.spec.site.depth} m ${model.spec.site.context} site, ${model.spec.region}`,
    },
    Building: {
      Name: model.spec.name,
      Description: `${model.typology?.name ?? model.spec.typology}, ${model.spec.massing.storeys} storeys`,
    },
    GuidSource: deterministic ? (): string => generateIfcGuid(guidRng.next) : undefined,
    Timestamp: deterministic ? DETERMINISTIC_TIMESTAMP_MS : undefined,
  });

  // ---- storeys -------------------------------------------------------------
  const storeyIds = new Map<string, number>();
  const storeys: StoreyDef[] = model.storeys.length > 0
    ? model.storeys
    : [{ id: 'L01', name: 'Level 1', index: 0, elevation: 0, height: 3, use: 'residential' }];
  if (model.storeys.length === 0) warn('writer: model has no storeys — created a single fallback storey L01');

  for (const storey of storeys) {
    const elevation = Number.isFinite(storey.elevation) ? storey.elevation : 0;
    if (!Number.isFinite(storey.elevation)) warn(`writer: storey ${storey.id}: non-finite elevation — using 0`);
    storeyIds.set(storey.id, creator.addIfcBuildingStorey({
      Name: storey.name || storey.id,
      Description: String(storey.use),
      Elevation: elevation,
    }));
  }
  const fallbackStorey = storeys.find(s => s.index === 0) ?? storeys[0];
  const fallbackStoreyId = storeyIds.get(fallbackStorey.id)!;
  const reportedStoreys = new Set<string>();

  const resolveStorey = (element: ModelElement): number => {
    const id = storeyIds.get(element.storey);
    if (id !== undefined) return id;
    if (!reportedStoreys.has(element.storey)) {
      reportedStoreys.add(element.storey);
      warn(`writer: ${element.id} (${element.geometry.kind}): unknown storey '${element.storey}' — placed in '${fallbackStorey.id}'`);
    }
    return fallbackStoreyId;
  };

  // ---- write order: hosts before hosted ------------------------------------
  const elements = model.elements ?? [];
  const wallElements: ModelElement[] = [];
  const bodyElements: ModelElement[] = [];
  const hostedElements: ModelElement[] = [];
  const wallGeometryById = new Map<string, Extract<ElementGeometry, { kind: 'wall' }>>();

  for (const element of elements) {
    const kind = element.geometry?.kind;
    if (kind === 'wall') {
      wallElements.push(element);
      wallGeometryById.set(element.id, element.geometry as Extract<ElementGeometry, { kind: 'wall' }>);
    } else if (kind === 'door-in-wall' || kind === 'window-in-wall') {
      hostedElements.push(element);
    } else {
      bodyElements.push(element);
    }
  }

  // Structure's verdict on load bearing walls wins over architecture's hint.
  const loadBearingArchWalls = new Set<string>(
    (model.struct?.walls ?? []).map(w => w.archWallId).filter((id): id is string => typeof id === 'string'),
  );
  // …and so does its verdict on what a wall IS: architecture types every solid
  // wall `SOLIDWALL`, but a wall structure has taken as part of the core or as
  // a shear wall is an IfcWall with PredefinedType SHEAR.
  const shearArchWalls = new Set<string>(
    (model.struct?.walls ?? [])
      .filter(w => w.role === 'core' || w.role === 'shear')
      .map(w => w.archWallId)
      .filter((id): id is string => typeof id === 'string'),
  );

  const idMap: Record<string, number> = {};
  const shared = newSharedSets();

  const writeOne = (element: ModelElement): void => {
    try {
      if (!element.geometry) {
        warn(`writer: ${element.id} (none): element has no geometry`);
        return;
      }
      if (!allNumbersFinite(element.geometry)) {
        warn(`writer: ${element.id} (${element.geometry.kind}): non-finite coordinate (NaN/Infinity) — skipped`);
        return;
      }
      if (idMap[element.id] !== undefined) {
        warn(`writer: ${element.id} (${element.geometry.kind}): duplicate element id — skipped`);
        return;
      }
      const expressId = writeGeometry(
        creator, element, resolveStorey(element), idMap, wallGeometryById, schema,
        shearArchWalls.has(element.id), warn,
      );
      if (expressId === null) return;
      idMap[element.id] = expressId;
      collectDefinitions(creator, element, expressId, loadBearingArchWalls.has(element.id), compact, shared, warn);
    } catch (error) {
      warn(`writer: ${element.id} (${element.geometry?.kind ?? 'none'}): ${(error as Error).message}`);
    }
  };

  for (const element of wallElements) writeOne(element);
  for (const element of bodyElements) writeOne(element);
  for (const element of hostedElements) writeOne(element);

  // ---- grouping ------------------------------------------------------------
  const systemGroups = new Map<string, number[]>();
  const zoneGroups = new Map<string, number[]>();
  for (const element of elements) {
    const expressId = idMap[element.id];
    if (expressId === undefined) continue;
    if (element.system) {
      const group = systemGroups.get(element.system);
      if (group) group.push(expressId);
      else systemGroups.set(element.system, [expressId]);
    }
    if (element.unitId && element.ifcType?.toUpperCase() === 'IFCSPACE') {
      const group = zoneGroups.get(element.unitId);
      if (group) group.push(expressId);
      else zoneGroups.set(element.unitId, [expressId]);
    }
  }

  for (const [systemId, memberIds] of systemGroups) {
    try {
      const { type, label } = systemClassification(systemId);
      creator.addIfcSystem(systemId, memberIds, {
        PredefinedType: type,
        ObjectType: label,
        LongName: label,
        Description: `${memberIds.length} elements`,
      });
    } catch (error) {
      warn(`writer: system ${systemId}: ${(error as Error).message}`);
    }
  }

  for (const [unitId, spaceIds] of zoneGroups) {
    try {
      creator.addIfcZone(unitId, spaceIds, { ObjectType: 'Dwelling', LongName: `Dwelling ${unitId}` });
    } catch (error) {
      warn(`writer: zone ${unitId}: ${(error as Error).message}`);
    }
  }

  // ---- property / quantity sets, shared across products --------------------
  // Written last, once every product's expressId is known: one IfcPropertySet
  // per DISTINCT (name + properties) tuple, bound to all of its products.
  for (const { set, members } of shared.psets.values()) {
    try {
      creator.addSharedIfcPropertySet(members, set);
    } catch (error) {
      warn(`writer: shared pset ${set.Name} (${members.length} elements): ${(error as Error).message}`);
    }
  }
  for (const { set, members } of shared.qsets.values()) {
    try {
      creator.addSharedIfcElementQuantity(members, set);
    } catch (error) {
      warn(`writer: shared quantities ${set.Name} (${members.length} elements): ${(error as Error).message}`);
    }
  }

  if (suppressed > 0) warnings.push(`writer: ${suppressed} further warnings suppressed`);

  const result = creator.toIfc();
  return {
    content: result.content,
    entityCount: result.stats.entityCount,
    fileSize: result.stats.fileSize,
    idMap,
    warnings,
  };
}

// ============================================================================
// Geometry dispatch
// ============================================================================

type Warn = (message: string) => void;

function writeGeometry(
  creator: IfcCreator,
  element: ModelElement,
  storeyId: number,
  idMap: Record<string, number>,
  wallGeometryById: Map<string, Extract<ElementGeometry, { kind: 'wall' }>>,
  schema: 'IFC2X3' | 'IFC4' | 'IFC4X3',
  isShearWall: boolean,
  warn: Warn,
): number | null {
  const g = element.geometry;
  const attrs = {
    Name: element.name || element.id,
    Description: element.description,
    ObjectType: element.objectType,
    Tag: element.id,
  };
  const reject = (why: string): null => {
    warn(`writer: ${element.id} (${g.kind}): ${why}`);
    return null;
  };

  switch (g.kind) {
    case 'wall': {
      if (!positive(g.thickness, g.height)) return reject('wall thickness/height must be > 0');
      if (dist3(g.start, g.end) < MIN_LENGTH) return reject('degenerate wall (start === end)');
      // A curtain wall is the one wall-shaped element that is NOT an IfcWall.
      if (element.ifcType?.toUpperCase() === 'IFCCURTAINWALL') {
        if (g.openings && g.openings.length > 0) {
          warn(`writer: ${element.id} (wall): IfcCurtainWall does not take openings — ${g.openings.length} opening(s) dropped`);
        }
        return creator.addIfcCurtainWall(storeyId, {
          ...attrs,
          Start: g.start as Point3D,
          End: g.end as Point3D,
          Height: g.height,
          Thickness: g.thickness,
        });
      }
      return creator.addIfcWall(storeyId, {
        ...attrs,
        Start: g.start as Point3D,
        End: g.end as Point3D,
        Thickness: g.thickness,
        Height: g.height,
        Openings: mapOpenings(g.openings, element.id, warn),
        // Structure's role wins: a core / shear wall is SHEAR whatever
        // architecture called it.
        PredefinedType: isShearWall ? 'SHEAR' : pick(WALL_TYPES, element.predefinedType, 'STANDARD'),
      });
    }

    case 'slab': {
      if (!positive(g.thickness)) return reject('slab thickness must be > 0');
      if (!g.profile || g.profile.length < 3) return reject('slab profile needs at least 3 points');
      const { w, d } = profileBounds(g.profile);
      return creator.addIfcSlab(storeyId, {
        ...attrs,
        Position: g.position as Point3D,
        Thickness: g.thickness,
        Width: w,
        Depth: d,
        Profile: g.profile as Point2D[],
        Openings: mapOpenings(g.openings, element.id, warn),
        PredefinedType: pick(SLAB_TYPES, element.predefinedType, 'FLOOR') as 'FLOOR',
      });
    }

    case 'column': {
      if (!positive(g.height)) return reject('column height must be > 0');
      if (g.shape === 'circle') {
        const radius = g.width / 2;
        if (!positive(radius)) return reject('circular column needs width > 0');
        return creator.addIfcCircularColumn(storeyId, {
          ...attrs, Position: g.position as Point3D, Radius: radius, Height: g.height,
        });
      }
      if (!positive(g.width, g.depth)) return reject('column width/depth must be > 0');
      return creator.addIfcColumn(storeyId, {
        ...attrs, Position: g.position as Point3D, Width: g.width, Depth: g.depth, Height: g.height,
      });
    }

    case 'beam': {
      if (!positive(g.width, g.height)) return reject('beam section must be > 0');
      if (dist3(g.start, g.end) < MIN_LENGTH) return reject('degenerate beam (start === end)');
      const params = {
        ...attrs, Start: g.start as Point3D, End: g.end as Point3D, Width: g.width, Height: g.height,
      };
      // Braces and struts are IfcMember, not IfcBeam — same geometry.
      return element.ifcType?.toUpperCase() === 'IFCMEMBER'
        ? creator.addIfcMember(storeyId, params)
        : creator.addIfcBeam(storeyId, params);
    }

    case 'box': {
      if (!positive(g.width, g.depth, g.height)) return reject('box dimensions must be > 0');
      const rotation = g.rotation ?? 0;
      if (element.ifcType?.toUpperCase() === 'IFCFURNISHINGELEMENT') {
        return creator.addIfcFurnishingElement(storeyId, {
          ...attrs,
          Position: g.position as Point3D,
          Width: g.width,
          Depth: g.depth,
          Height: g.height,
          Direction: rotation,
        });
      }
      const { location, refDirection } = boxPlacement(g.position, g.width, g.depth, rotation);
      return creator.addElement(storeyId, {
        ...attrs,
        IfcType: ifcTypeToken(element.ifcType, 'IFCBUILDINGELEMENTPROXY', schema),
        Placement: { Location: location, RefDirection: refDirection },
        Profile: { ProfileType: 'AREA', XDim: g.width, YDim: g.depth },
        Depth: g.height,
        PredefinedType: enumToken(element.predefinedType),
      });
    }

    case 'prism': {
      if (!positive(g.height)) return reject('prism height must be > 0');
      if (!g.profile || g.profile.length < 3) return reject('prism profile needs at least 3 points');
      const { w, d } = profileBounds(g.profile);
      const type = element.ifcType?.toUpperCase();
      if (type === 'IFCSPACE') {
        // IfcSpace has no Tag attribute — the element id rides in Description so
        // ModelElement ids still survive the round trip.
        return creator.addIfcSpace(storeyId, {
          Name: element.name || element.id,
          Description: element.id,
          ObjectType: element.objectType,
          LongName: element.description ?? element.name,
          Position: g.position as Point3D,
          Width: w,
          Depth: d,
          Height: g.height,
          Profile: g.profile as Point2D[],
          PredefinedType: pick(SPACE_TYPES, element.predefinedType, 'INTERNAL') as 'INTERNAL',
        });
      }
      if (type === 'IFCBUILDINGELEMENTPROXY' || type === undefined || type === '') {
        return creator.addIfcBuildingElementProxy(storeyId, {
          ...attrs,
          Position: g.position as Point3D,
          Width: w,
          Depth: d,
          Height: g.height,
          Profile: g.profile as Point2D[],
        });
      }
      return creator.addElement(storeyId, {
        ...attrs,
        IfcType: ifcTypeToken(element.ifcType, 'IFCBUILDINGELEMENTPROXY', schema),
        Placement: { Location: g.position as Point3D },
        Profile: { ProfileType: 'AREA', OuterCurve: g.profile as Point2D[] },
        Depth: g.height,
        PredefinedType: enumToken(element.predefinedType),
      });
    }

    case 'axis': {
      if (dist3(g.start, g.end) < MIN_LENGTH) return reject('degenerate axis (start === end)');
      let profile: ProfileDef;
      if (g.profile.type === 'circle') {
        if (!positive(g.profile.radius)) return reject('axis radius must be > 0');
        profile = { ProfileType: 'AREA', Radius: g.profile.radius };
      } else {
        if (!positive(g.profile.width, g.profile.height)) return reject('axis section must be > 0');
        profile = { ProfileType: 'AREA', XDim: g.profile.width, YDim: g.profile.height };
      }
      return creator.addAxisElement(storeyId, {
        ...attrs,
        IfcType: ifcTypeToken(element.ifcType, 'IFCBUILDINGELEMENTPROXY', schema),
        Start: g.start as Point3D,
        End: g.end as Point3D,
        Profile: profile,
        PredefinedType: enumToken(element.predefinedType),
      });
    }

    case 'stair': {
      const risers = Math.round(g.risers);
      if (!positive(risers, g.riserHeight, g.tread, g.width)) return reject('stair risers/dimensions must be > 0');
      return creator.addIfcStair(storeyId, {
        ...attrs,
        Position: g.position as Point3D,
        Direction: g.direction ?? 0,
        NumberOfRisers: risers,
        RiserHeight: g.riserHeight,
        TreadLength: g.tread,
        Width: g.width,
      });
    }

    case 'door-in-wall':
    case 'window-in-wall': {
      if (!positive(g.width, g.height)) return reject('opening width/height must be > 0');
      const sill = g.kind === 'window-in-wall' ? g.sill : 0;
      // The host must be a written element whose geometry kind is `wall`: only
      // those carry the wall placement + thickness the creator needs to align
      // the opening.
      const hostIsWall = wallGeometryById.has(g.hostId);
      const hostExpressId = hostIsWall ? idMap[g.hostId] : undefined;
      if (hostExpressId !== undefined) {
        if (g.kind === 'door-in-wall') {
          return creator.addIfcWallDoor(hostExpressId, {
            ...attrs,
            Position: [g.along, 0, 0],
            Width: g.width,
            Height: g.height,
            PredefinedType: pick(DOOR_TYPES, element.predefinedType, 'DOOR') as 'DOOR',
            OperationType: pick(DOOR_OPERATIONS, g.operation, 'SINGLE_SWING_LEFT') as 'SINGLE_SWING_LEFT',
          });
        }
        return creator.addIfcWallWindow(hostExpressId, {
          ...attrs,
          Position: [g.along, 0, sill],
          Width: g.width,
          Height: g.height,
          PartitioningType: pick(WINDOW_PARTITIONS, element.predefinedType, 'SINGLE_PANEL') as 'SINGLE_PANEL',
        });
      }

      // Host wall missing (never written, or a bad hostId): degrade to a
      // standalone door/window placed on the wall line when we can still find
      // the host's geometry, otherwise at the storey origin.
      const host = wallGeometryById.get(g.hostId);
      let position: Point3D = [0, 0, sill];
      if (host) {
        const length = dist3(host.start, host.end);
        const t = length > MIN_LENGTH ? Math.min(Math.max(g.along / length, 0), 1) : 0;
        position = [
          host.start[0] + (host.end[0] - host.start[0]) * t,
          host.start[1] + (host.end[1] - host.start[1]) * t,
          host.start[2] + sill,
        ];
      }
      const why = hostIsWall ? 'was not written' : 'is not a wall element';
      warn(`writer: ${element.id} (${g.kind}): host '${g.hostId}' ${why} — emitted as a standalone ${g.kind === 'door-in-wall' ? 'IfcDoor' : 'IfcWindow'}${host ? ' on the wall line' : ' at the storey origin'}`);
      if (g.kind === 'door-in-wall') {
        return creator.addIfcDoor(storeyId, {
          ...attrs, Position: position, Width: g.width, Height: g.height,
          PredefinedType: pick(DOOR_TYPES, element.predefinedType, 'DOOR') as 'DOOR',
          OperationType: pick(DOOR_OPERATIONS, g.operation, 'SINGLE_SWING_LEFT') as 'SINGLE_SWING_LEFT',
        });
      }
      return creator.addIfcWindow(storeyId, {
        ...attrs, Position: position, Width: g.width, Height: g.height,
        PartitioningType: pick(WINDOW_PARTITIONS, element.predefinedType, 'SINGLE_PANEL') as 'SINGLE_PANEL',
      });
    }

    case 'footing': {
      if (!positive(g.width, g.depth, g.height)) return reject('footing dimensions must be > 0');
      return creator.addIfcFooting(storeyId, {
        ...attrs,
        Position: g.position as Point3D,
        Width: g.width,
        Depth: g.depth,
        Height: g.height,
        PredefinedType: g.footingType ?? 'PAD_FOOTING',
      });
    }

    case 'pile': {
      if (!positive(g.diameter, g.length)) return reject('pile diameter/length must be > 0');
      return creator.addIfcPile(storeyId, {
        ...attrs,
        Position: g.position as Point3D,
        Length: g.length,
        Diameter: g.diameter,
        PredefinedType: pick(PILE_TYPES, element.predefinedType, 'BORED'),
      });
    }

    case 'roof': {
      if (!positive(g.width, g.depth, g.thickness)) return reject('roof dimensions must be > 0');
      const slope = clampSlope(g.slope ?? 0, 0, element, warn);
      return creator.addIfcRoof(storeyId, {
        ...attrs,
        Position: g.position as Point3D,
        Width: g.width,
        Depth: g.depth,
        Thickness: g.thickness,
        Slope: slope,
        PredefinedType: pick(ROOF_TYPES, element.predefinedType, slope > 0 ? 'SHED_ROOF' : 'FLAT_ROOF'),
      });
    }

    case 'gable-roof': {
      if (!positive(g.width, g.depth, g.thickness)) return reject('gable roof dimensions must be > 0');
      const slope = clampSlope(g.slope, 0.01, element, warn);
      const overhang = Number.isFinite(g.overhang ?? 0) && (g.overhang ?? 0) >= 0 ? (g.overhang ?? 0) : 0;
      return creator.addIfcGableRoof(storeyId, {
        ...attrs,
        Position: g.position as Point3D,
        Width: g.width,
        Depth: g.depth,
        Thickness: g.thickness,
        Slope: slope,
        Overhang: overhang,
        PredefinedType: pick(ROOF_TYPES, element.predefinedType, 'GABLE_ROOF') as GableRoofParams['PredefinedType'],
      });
    }

    case 'railing': {
      if (!positive(g.height)) return reject('railing height must be > 0');
      if (dist3(g.start, g.end) < MIN_LENGTH) return reject('degenerate railing (start === end)');
      const width = g.width !== undefined && positive(g.width) ? g.width : 0.05;
      return creator.addIfcRailing(storeyId, {
        ...attrs,
        Start: g.start as Point3D,
        End: g.end as Point3D,
        Height: g.height,
        Width: width,
        PredefinedType: pick(RAILING_TYPES, element.predefinedType, 'HANDRAIL') as 'HANDRAIL',
      });
    }

    case 'ramp': {
      if (!positive(g.width, g.length, g.thickness)) return reject('ramp dimensions must be > 0');
      const rise = Number.isFinite(g.rise) && g.rise >= 0 ? g.rise : 0;
      return creator.addIfcRamp(storeyId, {
        ...attrs,
        Position: g.position as Point3D,
        Width: g.width,
        Length: g.length,
        Thickness: g.thickness,
        Rise: rise,
      });
    }

    default: {
      const unknown = g as { kind?: string };
      warn(`writer: ${element.id} (${unknown.kind ?? 'unknown'}): unsupported geometry kind — skipped`);
      return null;
    }
  }
}

/** Slope must stay inside (min, π/2) for the creator's roof constructors. */
function clampSlope(slope: number, min: number, element: ModelElement, warn: Warn): number {
  const max = Math.PI / 2 - 0.01;
  if (!Number.isFinite(slope)) return min;
  if (slope < min || slope > max) {
    const clamped = Math.min(Math.max(slope, min), max);
    warn(`writer: ${element.id} (${element.geometry.kind}): slope ${slope.toFixed(3)} rad out of range — clamped to ${clamped.toFixed(3)}`);
    return clamped;
  }
  return slope;
}

function mapOpenings(
  openings: RectangularOpeningDef[] | undefined, elementId: string, warn: Warn,
): RectangularOpening[] | undefined {
  if (!openings || openings.length === 0) return undefined;
  const out: RectangularOpening[] = [];
  for (const opening of openings) {
    if (!positive(opening.width, opening.height) || !allNumbersFinite(opening.position)) {
      warn(`writer: ${elementId} (opening '${opening.name ?? '?'}'): invalid dimensions — opening skipped`);
      continue;
    }
    out.push({
      Name: opening.name,
      Width: opening.width,
      Height: opening.height,
      Position: opening.position as Point3D,
    });
  }
  return out.length > 0 ? out : undefined;
}

/** PascalCase `ifcType` → the UPPERCASE STEP entity name, down-mapped for IFC2X3. */
function ifcTypeToken(
  ifcType: string | undefined, fallback: string, schema: 'IFC2X3' | 'IFC4' | 'IFC4X3',
): string {
  const raw = (ifcType ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const token = raw.startsWith('IFC') && raw.length > 3 ? raw : fallback;
  if (schema !== 'IFC2X3') return token;
  return IFC2X3_TYPE_FALLBACKS[token] ?? token;
}

// ============================================================================
// Property sets, quantities, materials, colour
// ============================================================================

/**
 * Property and quantity sets waiting to be written, grouped by content.
 *
 * A generated building repeats a handful of property sets across thousands of
 * products: every `IfcOutlet` of one circuit type carries the same
 * `Forma_Electrical`, every stud wall of one type the same `Pset_WallCommon`.
 * Writing one set per product cost ~19 of the ~36 STEP entities per element.
 * Collecting them here and emitting one set per distinct content (bound to all
 * of its products) is exact — the products keep the same property values —
 * and costs one `IfcRelDefinesByProperties` per 250 products instead of one
 * per product.
 *
 * Map insertion order is first-use order, so the output stays deterministic.
 */
interface SharedSets {
  psets: Map<string, { set: CreatorPropertySet; members: number[] }>;
  qsets: Map<string, { set: CreatorQuantitySet; members: number[] }>;
}

function newSharedSets(): SharedSets {
  return { psets: new Map(), qsets: new Map() };
}

/** Quantity sets are only worth writing per element for these products in compact mode. */
const COMPACT_QUANTITY_TYPES = new Set(['IFCSPACE', 'IFCSLAB']);

/**
 * Colour + material go to the creator immediately (it batches them itself);
 * property and quantity sets are canonicalised and queued in `shared`.
 */
function collectDefinitions(
  creator: IfcCreator,
  element: ModelElement,
  expressId: number,
  forceLoadBearing: boolean,
  compact: boolean,
  shared: SharedSets,
  warn: Warn,
): void {
  if (element.color) {
    const rgb = element.color.map(c => Math.min(Math.max(Number.isFinite(c) ? c : 0.5, 0), 1)) as [number, number, number];
    creator.setColor(expressId, styleName(element), rgb);
  }

  if (element.material) {
    const material: CreatorMaterial = { Name: element.material.name, Category: element.material.category };
    const layers = (element.material.layers ?? []).filter(l => positive(l.thickness));
    if (layers.length > 0) {
      material.Layers = layers.map(l => ({ Name: l.name, Thickness: l.thickness, Category: l.category }));
    }
    creator.addIfcMaterial(expressId, material);
  }

  const psets = forceLoadBearing ? withLoadBearing(element.psets) : element.psets;
  for (const pset of psets ?? []) {
    if (!pset?.properties || pset.properties.length === 0) continue;
    const creatorPset = toCreatorPropertySet(pset, element.id, warn);
    // `IfcPropertySet.HasProperties` is SET [1:?] — if every property was
    // dropped as non-finite there is nothing left to attach.
    if (creatorPset.Properties.length === 0) continue;
    queue(shared.psets, canonicalPropertySet(creatorPset), expressId);
  }
  queue(shared.psets, canonicalPropertySet(formaCommon(element, compact)), expressId);

  if (compact && !COMPACT_QUANTITY_TYPES.has(element.ifcType?.toUpperCase() ?? '')) return;

  for (const qset of element.quantities ?? []) {
    if (!qset?.quantities || qset.quantities.length === 0) continue;
    const quantities = qset.quantities.filter(q => {
      if (Number.isFinite(q.value)) return true;
      warn(`writer: ${element.id} (quantity ${q.name}): non-finite value — skipped`);
      return false;
    });
    if (quantities.length === 0) continue;
    const creatorQset: CreatorQuantitySet = {
      Name: qset.name,
      Quantities: quantities.map(q => ({ Name: q.name, Value: q.value, Kind: q.kind })),
    };
    queue(shared.qsets, canonicalQuantitySet(creatorQset), expressId);
  }
}

function queue<T>(
  into: Map<string, { set: T; members: number[] }>,
  canonical: { key: string; set: T },
  expressId: number,
): void {
  const existing = into.get(canonical.key);
  if (existing) existing.members.push(expressId);
  else into.set(canonical.key, { set: canonical.set, members: [expressId] });
}

/**
 * Canonical form of a property set: properties sorted by name, plus the key
 * that decides whether two sets are the SAME set. The key carries the set
 * name, and each property's name, declared IFC type, JS type and value — so
 * `Amps = 100` never merges with `Amps = 200`, and `'1'` never merges with `1`.
 */
function canonicalPropertySet(pset: CreatorPropertySet): { key: string; set: CreatorPropertySet } {
  const properties = [...pset.Properties].sort(byName);
  // JSON, not concatenation: it escapes the separators, so no two distinct
  // property lists can collapse onto one key.
  const key = JSON.stringify([
    pset.Name,
    properties.map(p => [p.Name, p.Type ?? null, typeof p.NominalValue, p.NominalValue]),
  ]);
  return { key, set: { Name: pset.Name, Properties: properties } };
}

/** As {@link canonicalPropertySet}, for quantity sets (name, kind and value). */
function canonicalQuantitySet(qset: CreatorQuantitySet): { key: string; set: CreatorQuantitySet } {
  const quantities = [...qset.Quantities].sort(byName);
  const key = JSON.stringify([
    qset.Name,
    quantities.map(q => [q.Name, q.Kind, q.Value]),
  ]);
  return { key, set: { Name: qset.Name, Quantities: quantities } };
}

function byName(a: { Name: string }, b: { Name: string }): number {
  return a.Name < b.Name ? -1 : a.Name > b.Name ? 1 : 0;
}

/**
 * The appearance label for an element's colour — a CLASS-level name, never the
 * element's own.
 *
 * `finalizeStyles` keys its one-style-per-appearance cache on name + rgb, and a
 * viewer shows the name as the material/appearance in its legend. Passing
 * `element.name` gave one IfcSurfaceStyle per element (1 135 styles for the 64
 * distinct colours of one preset) with labels like `Air handler — U-L02-01`,
 * which is an element id, not an appearance.
 */
function styleName(element: ModelElement): string {
  return element.material?.name ?? element.objectType ?? element.ifcType ?? 'Forma';
}

/** Pset_WallCommon.LoadBearing = TRUE, merged without mutating the model. */
function withLoadBearing(psets: PropertySetDef[] | undefined): PropertySetDef[] {
  const out = (psets ?? []).map(p => ({ name: p.name, properties: [...p.properties] }));
  const wallCommon = out.find(p => p.name === 'Pset_WallCommon');
  if (!wallCommon) {
    out.push({ name: 'Pset_WallCommon', properties: [{ name: 'LoadBearing', value: true }] });
    return out;
  }
  const existing = wallCommon.properties.findIndex(p => p.name === 'LoadBearing');
  if (existing >= 0) wallCommon.properties[existing] = { name: 'LoadBearing', value: true };
  else wallCommon.properties.push({ name: 'LoadBearing', value: true });
  return out;
}

function propertyType(value: string | number | boolean): PropertyType {
  if (typeof value === 'boolean') return 'IfcBoolean';
  if (typeof value === 'number') return 'IfcReal';
  return 'IfcLabel';
}

function toCreatorPropertySet(pset: PropertySetDef, elementId: string, warn: Warn): CreatorPropertySet {
  const properties: CreatorPropertySet['Properties'] = [];
  for (const property of pset.properties) {
    if (typeof property.value === 'number' && !Number.isFinite(property.value)) {
      warn(`writer: ${elementId} (property ${pset.name}.${property.name}): non-finite value — skipped`);
      continue;
    }
    properties.push({ Name: property.name, NominalValue: property.value, Type: propertyType(property.value) });
  }
  return { Name: pset.name, Properties: properties };
}

/**
 * Every product gets a `Forma_Common` pset so that discipline, storey, MEP
 * system and the patterns that produced it are readable in any IFC viewer.
 *
 * In compact mode the pset holds only these CLASS-level facts, which is what
 * makes it shareable: `ElementId` is the product's own `Tag` already (IfcSpace:
 * `Description`), and `UnitId` / `RoomId` would make the pset unique per
 * element — 28 000 property sets instead of a few hundred — for data the
 * per-dwelling `IfcZone` and the space geometry already carry. Full mode keeps
 * all six, at the cost of one property set per element.
 */
function formaCommon(element: ModelElement, compact: boolean): CreatorPropertySet {
  const properties = [
    { Name: 'Discipline', NominalValue: element.discipline, Type: 'IfcLabel' as PropertyType },
    { Name: 'Storey', NominalValue: element.storey, Type: 'IfcLabel' as PropertyType },
  ];
  if (!compact) {
    properties.push({ Name: 'ElementId', NominalValue: element.id, Type: 'IfcIdentifier' as PropertyType });
    if (element.unitId) properties.push({ Name: 'UnitId', NominalValue: element.unitId, Type: 'IfcIdentifier' as PropertyType });
    if (element.roomId) properties.push({ Name: 'RoomId', NominalValue: element.roomId, Type: 'IfcIdentifier' as PropertyType });
  }
  if (element.system) properties.push({ Name: 'System', NominalValue: element.system, Type: 'IfcIdentifier' as PropertyType });
  properties.push({ Name: 'Patterns', NominalValue: (element.patterns ?? []).join(','), Type: 'IfcLabel' as PropertyType });
  return { Name: 'Forma_Common', Properties: properties };
}
