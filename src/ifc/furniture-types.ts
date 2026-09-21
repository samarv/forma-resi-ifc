/**
 * The IFC furniture type library: `FurnitureTypeDef` → `IfcFurnitureType` /
 * `IfcSanitaryTerminalType` / `IfcElectricApplianceType` /
 * `IfcBuildingElementProxyType` with an `IfcRepresentationMap`, plus the
 * `IfcProductDefinitionShape` that every occurrence of that type shares.
 *
 * Why a type library at all. A mid-rise carries ~1 800 pieces of furniture. Written
 * per product (one extruded box each) that is ~6.6 STEP entities per item and the
 * geometry is a bounding box. Written as mapped items it is ~4.0 entities per item —
 * an IfcCartesianPoint, an IfcAxis2Placement3D, an IfcLocalPlacement and the
 * occurrence itself, all of which are genuinely per-item because every item sits at
 * its own XY — while the 3–8 primitives that make a bed look like a bed are authored
 * ONCE per type. Cheaper AND recognisable.
 *
 * The encoding, per type:
 *
 *     per solid  IFCEXTRUDEDAREASOLID + IFCSTYLEDITEM   (profile/point/placement cached)
 *                IFCSHAPEREPRESENTATION 'Body','SolidModel'
 *                IFCREPRESENTATIONMAP
 *                IFCMAPPEDITEM  ──── the ONE identity IFCCARTESIANTRANSFORMATIONOPERATOR3D
 *                IFCSHAPEREPRESENTATION 'Body','MappedRepresentation'
 *                IFCPRODUCTDEFINITIONSHAPE   ← shared by every occurrence
 *                IFCFURNITURETYPE (or the sanitary/appliance/proxy type)
 *                IFCRELDEFINESBYTYPE   (deferred, one line per 500 occurrences)
 *
 * The identity operator is what keeps the product definition shape shareable: the
 * type's solids are authored at the type origin and each occurrence carries its own
 * position and rotation in its `IfcLocalPlacement`, so no occurrence needs an
 * operator of its own. Linking occurrences with `IfcRelDefinesByType` also stops a
 * viewer from drawing the type's map a second time as orphan type-only geometry.
 *
 * Deviation from the design note: `IFCFURNITURETYPE` has ELEVEN attributes in IFC4,
 * not ten — IFC4 kept IFC2X3's `AssemblyPlace` (as optional) and appended
 * `PredefinedType` after it. See `addTypeObject`.
 */
import type { FurnitureTypeDef, Solid } from '../core/furniture-3d.ts';
import type { RGB, Vec2 } from '../core/types.ts';
import { OCCURRENCE_OF } from '../core/furniture-3d.ts';
import type { IfcCreator } from './vendor/ifc-lite-create/ifc-creator.ts';
import type { Point2D, Point3D } from './vendor/ifc-lite-create/types.ts';

type Warn = (message: string) => void;

export interface TypeLibEntry {
  /** expressId of the IfcFurnitureType / …SanitaryTerminalType / … */
  typeId: number;
  /** expressId of its IfcRepresentationMap */
  mapId: number;
  /** expressId of the IfcProductDefinitionShape shared by every occurrence */
  prodShapeId: number;
  /** expressIds of the occurrences, in write order (→ IfcRelDefinesByType) */
  occurrences: number[];
}

export interface TypeLibrary {
  /** `FurnitureTypeDef.id` → its entry, in first-use order */
  entries: Map<string, TypeLibEntry>;
  /** the file-wide identity IfcCartesianTransformationOperator3D, created on first use */
  identityOperatorId: number | null;
}

export function newTypeLibrary(): TypeLibrary {
  return { entries: new Map(), identityOperatorId: null };
}

/** Entity name of the type object for each `FurnitureIfcType`. */
const TYPE_ENTITY = {
  IfcFurnitureType: 'IFCFURNITURETYPE',
  IfcSanitaryTerminalType: 'IFCSANITARYTERMINALTYPE',
  IfcElectricApplianceType: 'IFCELECTRICAPPLIANCETYPE',
  IfcBuildingElementProxyType: 'IFCBUILDINGELEMENTPROXYTYPE',
} as const;

/** Number of points in the polygonal approximation of an ellipse profile. */
const ELLIPSE_SEGMENTS = 16;

/**
 * Get (or create) the entry for a type, authoring its geometry on first use.
 *
 * Call order fixes express ids, and `writeIfc` walks elements in a fixed order, so
 * the library is deterministic without sorting anything.
 */
export function ensureFurnitureType(
  creator: IfcCreator, lib: TypeLibrary, def: FurnitureTypeDef,
): TypeLibEntry {
  const existing = lib.entries.get(def.id);
  if (existing) return existing;

  if (lib.identityOperatorId === null) {
    lib.identityOperatorId = creator.addCartesianTransformationOperator3D();
  }

  const solidIds: number[] = [];
  for (const solid of def.solids) {
    const solidId = addSolid(creator, solid);
    solidIds.push(solidId);
    const rgb = clampRgb(solid.color ?? def.color);
    // The style NAME must be a pure function of the colour: finalizeStyles caches
    // one IfcSurfaceStyle per `name|rgb`, so the whole library costs one style per
    // palette colour rather than one per type.
    creator.setSolidColor(solidId, styleNameOf(rgb), rgb);
  }

  const bodyRepId = creator.addBodyRepresentation(solidIds);
  const mapId = creator.addRepresentationMap(bodyRepId);
  const mappedItemId = creator.addMappedItem(mapId, lib.identityOperatorId);
  const mappedRepId = creator.addMappedShapeRepresentation([mappedItemId]);
  const prodShapeId = creator.addProductDefinitionShape([mappedRepId]);
  const typeId = creator.addTypeObject(TYPE_ENTITY[def.ifcType], {
    Name: typeName(def),
    RepresentationMaps: [mapId],
    Tag: def.id,
    ElementType: def.furnitureType,
    PredefinedType: def.predefinedType ?? 'NOTDEFINED',
  });

  const entry: TypeLibEntry = { typeId, mapId, prodShapeId, occurrences: [] };
  lib.entries.set(def.id, entry);
  return entry;
}

/**
 * Bind every occurrence to its type. Deferred to the end of the write, because
 * `IfcRelDefinesByType` is not idempotent — one relationship (chunked) per type,
 * once all of its occurrences exist.
 */
export function finalizeFurnitureTypes(creator: IfcCreator, lib: TypeLibrary, warn: Warn): void {
  for (const [id, entry] of lib.entries) {
    if (entry.occurrences.length === 0) {
      // Unreachable in practice (a type is created for an occurrence that is
      // about to be written) — but an un-instantiated type's representation map
      // would be drawn as orphan type-only geometry at the world origin.
      warn(`writer: furniture type ${id}: no occurrences — type geometry may render at the origin`);
      continue;
    }
    try {
      creator.addRelDefinesByType(entry.typeId, entry.occurrences);
    } catch (error) {
      warn(`writer: furniture type ${id} (${entry.occurrences.length} occurrences): ${(error as Error).message}`);
    }
  }
}

// ============================================================================
// Solids
// ============================================================================

/**
 * One `Solid` → one `IfcExtrudedAreaSolid`, positioned by its own
 * `IfcAxis2Placement3D` inside the type's shape representation.
 *
 * The extrusion always runs along the placement's local +Z, so a sideways solid
 * (`axis: 'x' | 'y'`) is a rotated placement rather than a rotated profile:
 *
 *   axis 'z'  local frame = world; profile (u, v) → (x + u, y + v)
 *   axis 'x'  Axis +X, RefDirection +Y  → local X = world +Y, local Y = world +Z
 *   axis 'y'  Axis +Y, RefDirection +X  → local X = world +X, local Y = world −Z
 *
 * `axis: 'y'` is the one left-handed pairing (X, Z, Y), so its profile points are
 * mirrored in v and reversed to keep the profile counter-clockwise in its own
 * plane. `box` ignores `axis` entirely: its bounding box is w × d × h whichever
 * direction it is extruded in, which is exactly what `solidBounds` says.
 */
function addSolid(creator: IfcCreator, s: Solid): number {
  const axis = s.axis ?? 'z';
  const dirs = axis === 'x'
    ? { Axis: [1, 0, 0] as Point3D, RefDirection: [0, 1, 0] as Point3D }
    : axis === 'y'
      ? { Axis: [0, 1, 0] as Point3D, RefDirection: [1, 0, 0] as Point3D }
      : {};

  if (s.kind === 'box') {
    const profileId = creator.addRectangleProfile(s.w, s.d, [s.w / 2, s.d / 2]);
    const positionId = placement(creator, [s.x, s.y, s.z], {});
    return creator.addExtrudedAreaSolid(profileId, s.h, undefined, positionId);
  }

  if (s.kind === 'cyl') {
    const profileId = creator.addCircleProfile(s.r);
    const positionId = placement(creator, [s.x, s.y, s.z], dirs);
    return creator.addExtrudedAreaSolid(profileId, s.h, undefined, positionId);
  }

  // ellipse → a 16-gon through addArbitraryProfile. IfcEllipseProfileDef would be
  // legal but is unverified in the viewer's parametric-profile router, and two
  // users (a bathtub's water, a basin) do not justify the risk.
  const points: Vec2[] = s.kind === 'ellipse'
    ? ellipse(s.rx, s.ry)
    : s.poly.map(p => [p[0], p[1]] as Vec2);
  const profileId = creator.addArbitraryProfile(profilePoints(points, axis));
  const positionId = placement(creator, [s.x, s.y, s.z], dirs);
  return creator.addExtrudedAreaSolid(profileId, s.h, undefined, positionId);
}

function placement(
  creator: IfcCreator, origin: Point3D, dirs: { Axis?: Point3D; RefDirection?: Point3D },
): number {
  const originId = creator.addCartesianPoint3D(origin);
  const axisId = dirs.Axis ? creator.addDirection3D(dirs.Axis) : undefined;
  const refDirId = dirs.RefDirection ? creator.addDirection3D(dirs.RefDirection) : undefined;
  return creator.addAxis2Placement3D(originId, axisId, refDirId);
}

/** Mirror + reverse for the left-handed `axis: 'y'` frame; identity otherwise. */
function profilePoints(points: Vec2[], axis: 'x' | 'y' | 'z'): Point2D[] {
  if (axis !== 'y') return points.map(p => [p[0], p[1]] as Point2D);
  return points.map(p => [p[0], -p[1]] as Point2D).reverse();
}

function ellipse(rx: number, ry: number): Vec2[] {
  const points: Vec2[] = [];
  for (let i = 0; i < ELLIPSE_SEGMENTS; i++) {
    const a = (i / ELLIPSE_SEGMENTS) * Math.PI * 2;
    points.push([round4(rx * Math.cos(a)), round4(ry * Math.sin(a))]);
  }
  return points;
}

// ============================================================================
// Naming
// ============================================================================

/** 'bed-queen' → 'Bed Queen'; per-length types get their width. */
function typeName(def: FurnitureTypeDef): string {
  const words = def.furnitureType.split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  return def.stretch ? `${words} ${def.footprint.w.toFixed(2)} m` : words;
}

/**
 * Appearance label for a type solid — a pure function of the colour, so the
 * eleven palette colours of the whole library share eleven IfcSurfaceStyles.
 */
function styleNameOf(rgb: RGB): string {
  const hex = rgb.map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join('');
  return `Furn-${hex}`;
}

function clampRgb(rgb: RGB): [number, number, number] {
  return rgb.map(c => Math.min(Math.max(Number.isFinite(c) ? c : 0.5, 0), 1)) as [number, number, number];
}

function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

/** The occurrence entity for a type, e.g. `IfcFurnitureType` → `IFCFURNISHINGELEMENT`. */
export function occurrenceEntity(def: FurnitureTypeDef): string {
  return OCCURRENCE_OF[def.ifcType];
}
