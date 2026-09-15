/**
 * Mechanical build state: indexes over the architecture model, storey plenum bands,
 * id allocation, element emission and pattern bookkeeping.
 *
 * Z CONVENTIONS (storey-local, see core/types.ts)
 * - Every horizontal DUCT run lives in a ceiling plenum band, so every point of every
 *   IfcDuctSegment path satisfies `ceilingHeight <= z <= floorToFloor - slabT`. Runs are
 *   modelled from the point where they enter the plenum; the short stub from a piece of
 *   equipment up to the plenum is not modelled.
 * - Risers are emitted PER STOREY, each one segment from z = 0 to z = that storey's
 *   floor-to-floor height, tagged 'riser'.
 * - Refrigerant / hydronic lines are IfcPipeSegment (not IfcDuctSegment) and MAY leave the
 *   plenum band to reach a condenser on a balcony or a ground pad.
 */
import type {
  AirTerminal, CorridorDef, DoorDef, DuctRun, DuctSystemType, FloorPlan, FurnitureDef, GenContext,
  HvacSystemId, MechEquipment, ModelElement, PatternApplication, PropertySetDef, Rect, RGB, Riser,
  RoomDef, ShaftDef, StoreyDef, UnitInstance, Vec2, Vec3, VentilationStrategy, WallDef, WindowDef,
} from '../../core/types.ts';
import { IdFactory, systemId, ROOF_STOREY } from '../../core/ids.ts';
import { plenumBands, type PlenumBands } from '../../core/coordination.ts';
import { polygonBounds, rectUnionBounds } from '../../core/geometry.ts';
import { PlantGrid, derivePlantZone, dedupe, shaftSlot } from './placement.ts';
import { r1, r3 } from './loads.ts';

export type MechSystemKey = DuctSystemType | 'refrigerant' | 'hydronic' | 'controls';

/** Discipline palette (RGB 0..1) keyed by system */
export const SYSTEM_COLOR: Record<string, RGB> = {
  supply: [0.35, 0.6, 1.0],
  return: [1.0, 0.55, 0.75],
  exhaust: [0.55, 0.85, 0.35],
  'outdoor-air': [0.2, 0.8, 0.8],
  'kitchen-exhaust': [0.8, 0.7, 0.3],
  'dryer-exhaust': [0.8, 0.7, 0.3],
  'corridor-pressurization': [0.35, 0.6, 1.0],
  refrigerant: [0.6, 0.4, 0.8],
  hydronic: [0.6, 0.4, 0.8],
  controls: [0.45, 0.55, 0.65],
  equipment: [0.45, 0.55, 0.65],
};

export const EQUIPMENT_COLOR: RGB = [0.45, 0.55, 0.65];

export interface IfcMap {
  ifcType: string;
  predefinedType?: string;
  objectType?: string;
  /** System the piece of equipment belongs to */
  system: MechSystemKey;
}

/** MechEquipment.type → IFC entity (IFC4). `position` is always the box MIN corner. */
export const EQUIPMENT_IFC: Record<MechEquipment['type'], IfcMap> = {
  'heat-pump-outdoor': { ifcType: 'IfcUnitaryEquipment', predefinedType: 'SPLITSYSTEM', objectType: 'Outdoor condensing unit', system: 'refrigerant' },
  'indoor-unit': { ifcType: 'IfcUnitaryEquipment', predefinedType: 'AIRHANDLER', objectType: 'Indoor air handler', system: 'supply' },
  erv: { ifcType: 'IfcAirToAirHeatRecovery', predefinedType: 'FIXEDPLATECOUNTERFLOWEXCHANGER', objectType: 'Energy recovery ventilator', system: 'outdoor-air' },
  mvhr: { ifcType: 'IfcAirToAirHeatRecovery', predefinedType: 'FIXEDPLATECOUNTERFLOWEXCHANGER', objectType: 'MVHR unit', system: 'outdoor-air' },
  ahu: { ifcType: 'IfcUnitaryEquipment', predefinedType: 'AIRHANDLER', objectType: 'Central air handling unit', system: 'supply' },
  rtu: { ifcType: 'IfcUnitaryEquipment', predefinedType: 'ROOFTOPUNIT', objectType: 'Rooftop unit', system: 'supply' },
  'exhaust-fan': { ifcType: 'IfcFan', predefinedType: 'CENTRIFUGALFORWARDCURVED', objectType: 'Exhaust fan', system: 'exhaust' },
  'range-hood': { ifcType: 'IfcFan', predefinedType: 'CENTRIFUGALFORWARDCURVED', objectType: 'Range hood', system: 'kitchen-exhaust' },
  'fan-coil': { ifcType: 'IfcUnitaryEquipment', predefinedType: 'AIRCONDITIONINGUNIT', objectType: 'Fan coil unit', system: 'supply' },
  radiator: { ifcType: 'IfcSpaceHeater', predefinedType: 'RADIATOR', objectType: 'Panel radiator', system: 'hydronic' },
  ptac: { ifcType: 'IfcUnitaryEquipment', predefinedType: 'AIRCONDITIONINGUNIT', objectType: 'Packaged terminal air conditioner', system: 'supply' },
  'vrf-condenser': { ifcType: 'IfcUnitaryEquipment', predefinedType: 'SPLITSYSTEM', objectType: 'VRF condenser', system: 'refrigerant' },
  boiler: { ifcType: 'IfcBoiler', predefinedType: 'WATER', objectType: 'Boiler', system: 'hydronic' },
  chiller: { ifcType: 'IfcChiller', predefinedType: 'AIRCOOLED', objectType: 'Chiller', system: 'hydronic' },
  'heat-interface-unit': { ifcType: 'IfcUnitaryEquipment', predefinedType: 'NOTDEFINED', objectType: 'HIU', system: 'hydronic' },
  thermostat: { ifcType: 'IfcUnitaryControlElement', predefinedType: 'THERMOSTAT', objectType: 'Room thermostat', system: 'controls' },
};

export const TERMINAL_IFC: Record<AirTerminal['type'], { predefinedType: string; system: DuctSystemType; airflowType: string }> = {
  'supply-diffuser': { predefinedType: 'DIFFUSER', system: 'supply', airflowType: 'SUPPLYAIR' },
  'return-grille': { predefinedType: 'GRILLE', system: 'return', airflowType: 'RETURNAIR' },
  'exhaust-grille': { predefinedType: 'GRILLE', system: 'exhaust', airflowType: 'EXHAUSTAIR' },
  louver: { predefinedType: 'LOUVRE', system: 'outdoor-air', airflowType: 'SUPPLYAIR' },
  'transfer-grille': { predefinedType: 'GRILLE', system: 'return', airflowType: 'TRANSFERAIR' },
};

export interface StoreyInfo {
  id: string;
  index: number;
  elevation: number;
  floorToFloor: number;
  ceilingHeight: number;
  slabT: number;
  /** Has dwellings on it */
  isResidential: boolean;
  corridors: CorridorDef[];
  unitIds: string[];
  bands: PlenumBands;
  /** Corridor duct band (pattern XD-02) */
  corridorDuctZ: number;
  corridorDuctDepth: number;
  /** Dwelling hall-ceiling duct band (pattern MEC-02) */
  unitDuctZ: number;
  unitDuctDepth: number;
}

export interface AddEquipmentOpts {
  storey: string;
  type: MechEquipment['type'];
  /** Box MIN corner, storey-local Z */
  position: Vec3;
  width: number;
  depth: number;
  height: number;
  rotation?: number;
  roomId?: string;
  unitId?: string;
  capacityKw?: number;
  name?: string;
  ifc?: Partial<IfcMap>;
  patterns?: string[];
  tags?: string[];
  serves?: string;
  airflowLs?: number;
}

export interface AddDuctOpts {
  storey: string;
  systemType: DuctSystemType;
  path: Vec3[];
  shape: 'rect' | 'round';
  /** For round ducts this is the diameter */
  width: number;
  height: number;
  servesRoomIds?: string[];
  unitId?: string;
  airflowLs?: number;
  name?: string;
  patterns?: string[];
  /** Emit IfcPipeSegment instead of IfcDuctSegment (refrigerant / hydronic) */
  pipe?: boolean;
  /** Overrides the system id derived from systemType */
  systemOverride?: MechSystemKey;
  tags?: string[];
}


export interface AddTerminalOpts {
  storey: string;
  type: AirTerminal['type'];
  roomId: string;
  unitId?: string;
  xy: Vec2;
  /** Ceiling height of the room (terminal face sits flush with it) */
  z: number;
  width?: number;
  depth?: number;
  airflowLs: number;
  patterns?: string[];
  name?: string;
}

export interface AddRiserOpts {
  shaftId: string;
  systemType: Riser['systemType'];
  fromStorey: string;
  toStorey: string;
  xy: Vec2;
  width: number;
  height: number;
  shape: 'rect' | 'round';
  airflowLs?: number;
  patterns?: string[];
  serves?: string;
  /** Discriminator used in the riser id when one shaft carries two risers of the same systemType */
  label?: string;
}

const PATTERN_APP_CAP = 64;

export class MechBuild {
  readonly ctx: GenContext;
  readonly ids: IdFactory;
  readonly hvac: HvacSystemId;
  readonly ventilation: VentilationStrategy;
  readonly detail: 'low' | 'medium' | 'high';

  readonly equipment: MechEquipment[] = [];
  readonly ducts: DuctRun[] = [];
  readonly terminals: AirTerminal[] = [];
  readonly risers: Riser[] = [];
  readonly elements: ModelElement[] = [];
  readonly patterns: PatternApplication[] = [];

  /** Indexes */
  readonly rooms = new Map<string, RoomDef>();
  readonly walls = new Map<string, WallDef>();
  readonly doors = new Map<string, DoorDef>();
  readonly windowsByRoom = new Map<string, WindowDef[]>();
  readonly furnitureByRoom = new Map<string, FurnitureDef[]>();
  readonly storeyInfo = new Map<string, StoreyInfo>();
  readonly storeys: StoreyDef[];
  readonly floors: FloorPlan[] = [];
  readonly units: UnitInstance[] = [];
  readonly shafts: ShaftDef[] = [];
  readonly resiStoreys: StoreyInfo[] = [];

  plantZone: Rect;
  readonly roofGrid: PlantGrid;
  private shaftSlots = new Map<string, number>();
  private riserByKey = new Map<string, Riser>();
  private centreClaimed = new Set<string>();
  private groundPadIndex = 0;
  private groundPadOrigin: Vec2 = [0, 0];
  private patternCounts = new Map<string, number>();

  /** Running totals */
  ductLengthM = 0;
  /** Extract branches longer than the MEC-03 target of 12 m (reported once, in aggregate) */
  longExtractRuns = 0;
  longestExtractM = 0;

  constructor(ctx: GenContext, hvac: HvacSystemId, ventilation: VentilationStrategy) {
    this.ctx = ctx;
    this.ids = new IdFactory('mechanical');
    this.hvac = hvac;
    this.ventilation = ventilation;
    this.detail = ctx.spec.options.detail;
    this.storeys = ctx.storeys;

    const arch = ctx.arch;
    if (arch) {
      for (const r of arch.rooms) this.rooms.set(r.id, r);
      for (const w of arch.walls) this.walls.set(w.id, w);
      for (const d of arch.doors) this.doors.set(d.id, d);
      for (const w of arch.windows) push(this.windowsByRoom, w.roomId, w);
      for (const f of arch.furniture) push(this.furnitureByRoom, f.roomId, f);
      for (const f of arch.floors) this.floors.push(f);
      for (const u of arch.units) this.units.push(u);
      for (const s of arch.shafts) this.shafts.push(s);
    }

    const slabDefault = ctx.struct?.sizes.slabT ?? 0.2;
    const floorByStorey = new Map(this.floors.map(f => [f.storey, f] as const));
    for (const s of this.storeys) {
      const fp = floorByStorey.get(s.id);
      const f2f = fp?.floorToFloor ?? (s.height > 0 ? s.height : 3.0);
      const slabT = fp?.slabThickness ?? slabDefault;
      const ceilingWanted = fp?.ceilingHeight ?? Math.max(2.3, Math.min(f2f - 0.45, 2.7));
      // Never let a nominal ceiling sit above the structure (SITE / FND / ROOF have tiny heights)
      const ceiling = Math.min(ceilingWanted, Math.max(0.4, f2f - slabT - 0.1));
      const beamDepth = this.beamDepthUnder(f2f, slabT);
      const bands = plenumBands(f2f, slabT, beamDepth, ceiling);
      const corridorDuctDepth = fitDepth(0.3, bands.ductZ, bands.ceilingZ, bands.soffitZ);
      const unit = unitDuctBand(f2f, slabT, ceiling, 0.25);
      const info: StoreyInfo = {
        id: s.id,
        index: s.index,
        elevation: s.elevation,
        floorToFloor: f2f,
        ceilingHeight: ceiling,
        slabT,
        isResidential: (fp?.unitIds.length ?? 0) > 0,
        corridors: fp?.corridors ?? [],
        unitIds: fp?.unitIds ?? [],
        bands,
        corridorDuctZ: r3(bands.ductZ),
        corridorDuctDepth: r3(corridorDuctDepth),
        unitDuctZ: r3(unit.z),
        unitDuctDepth: r3(unit.depth),
      };
      this.storeyInfo.set(s.id, info);
      if (info.isResidential) this.resiStoreys.push(info);
      if (unit.tight && info.isResidential) {
        ctx.warnings.push(`MEC: storey ${s.id} ceiling plenum is only ${r3(f2f - slabT - ceiling)} m — dwelling duct sits tight to the ceiling`);
      }
    }
    this.resiStoreys.sort((a, b) => a.index - b.index);

    // Roof plant zone (MEC-06)
    const roofBounds = arch ? polygonBounds(arch.roof.outline) : rectUnionBounds(this.units.map(u => u.rect));
    this.plantZone = arch?.roof.plantZone ?? derivePlantZone(roofBounds, this.units.length);
    this.roofGrid = new PlantGrid(this.plantZone, 1.0);

    // Ground pad at the rear of the footprint (MEC-04 fallback)
    this.groundPadOrigin = [roofBounds.x + 1.0, roofBounds.y + roofBounds.h + 1.0];
  }

  /**
   * Depth of structure hanging below the slab over the corridor. With no beams there is
   * nothing below the soffit; with beams, `struct.plenumClearance.corridorSoffitZ` (if set)
   * says where the structure stops, otherwise the typical beam depth is assumed.
   */
  private beamDepthUnder(f2f: number, slabT: number): number {
    const st = this.ctx.struct;
    if (!st || st.beams.length === 0) return 0;
    const soffit = f2f - slabT;
    const clear = st.plenumClearance?.corridorSoffitZ ?? 0;
    if (clear > 0 && clear < soffit) return Math.max(0, soffit - clear);
    return st.sizes.beamD;
  }

  storey(id: string): StoreyInfo {
    const s = this.storeyInfo.get(id);
    if (s) return s;
    const fallback: StoreyInfo = {
      id, index: 0, elevation: 0, floorToFloor: 3.0, ceilingHeight: 2.6, slabT: 0.2,
      isResidential: false, corridors: [], unitIds: [],
      bands: plenumBands(3.0, 0.2, 0, 2.6),
      corridorDuctZ: 2.75, corridorDuctDepth: 0.2, unitDuctZ: 2.75, unitDuctDepth: 0.2,
    };
    this.storeyInfo.set(id, fallback);
    return fallback;
  }

  roofStoreyId(): string {
    return this.storeys.some(s => s.id === ROOF_STOREY) ? ROOF_STOREY : (this.resiStoreys[this.resiStoreys.length - 1]?.id ?? 'L01');
  }

  lowestResidentialStoreyId(): string {
    return this.resiStoreys[0]?.id ?? this.storeys.find(s => s.index >= 0)?.id ?? 'L01';
  }

  /** Storeys from `fromId` (inclusive) up to but excluding ROOF — the span a riser is emitted over */
  riserSpan(fromId: string, toId: string): StoreyInfo[] {
    const from = this.storeyInfo.get(fromId);
    const to = this.storeyInfo.get(toId);
    if (!from) return [];
    const hi = to ? to.index : 100;
    return this.storeys
      .filter(s => s.index >= from.index && s.index < hi && s.index >= 0 && s.id !== ROOF_STOREY)
      .map(s => this.storey(s.id));
  }

  unitRooms(unit: UnitInstance): RoomDef[] {
    const out: RoomDef[] = [];
    for (const id of unit.roomIds) {
      const r = this.rooms.get(id);
      if (r) out.push(r);
    }
    return out;
  }

  entryPoint(unit: UnitInstance): Vec2 | null {
    const door = this.doors.get(unit.entryDoorId);
    if (!door) return null;
    const wall = this.walls.get(door.wallId);
    if (!wall) return null;
    const dx = wall.end[0] - wall.start[0];
    const dy = wall.end[1] - wall.start[1];
    const l = Math.hypot(dx, dy);
    if (l < 1e-6) return wall.start;
    const t = Math.max(0, Math.min(1, door.along / l));
    return [wall.start[0] + dx * t, wall.start[1] + dy * t];
  }

  /** Exterior wall serving a room, or any exterior wall of the unit */
  exteriorWallOf(room: RoomDef | null, unit?: UnitInstance): WallDef | null {
    if (room) {
      for (const id of room.exteriorWallIds) {
        const w = this.walls.get(id);
        if (w) return w;
      }
      for (const id of room.wallIds) {
        const w = this.walls.get(id);
        if (w && w.isExternal) return w;
      }
    }
    if (unit) {
      for (const r of this.unitRooms(unit)) {
        for (const id of r.exteriorWallIds) {
          const w = this.walls.get(id);
          if (w) return w;
        }
      }
    }
    return null;
  }

  /** Longest interior wall of a room (thermostats, wall-hung plant) */
  interiorWallOf(room: RoomDef): WallDef | null {
    let best: WallDef | null = null;
    let bestLen = 0;
    for (const id of room.wallIds) {
      const w = this.walls.get(id);
      if (!w || w.isExternal) continue;
      const l = Math.hypot(w.end[0] - w.start[0], w.end[1] - w.start[1]);
      if (l > bestLen) { bestLen = l; best = w; }
    }
    return best;
  }

  windowsOf(roomId: string): WindowDef[] { return this.windowsByRoom.get(roomId) ?? []; }
  furnitureOf(roomId: string): FurnitureDef[] { return this.furnitureByRoom.get(roomId) ?? []; }

  /**
   * Next mechanical riser slot inside a shaft. Slot 0 (the exact shaft centre) is reserved
   * for the shaft's MAIN air riser, so this counter starts at 1.
   */
  nextShaftSlot(shaftId: string): number {
    const n = this.shaftSlots.get(shaftId) ?? 1;
    this.shaftSlots.set(shaftId, n + 1);
    return n;
  }

  /**
   * XY for a riser inside a shaft. `preferCentre` gives the first air riser in that shaft the
   * exact centre (the mechanical claim in the shaft-slot convention); everything else steps
   * along the shaft's long axis. Plumbing takes the corridor-left corner, electrical the
   * corridor-right corner — mechanical never occupies a corner.
   */
  claimShaftXY(shaft: ShaftDef, preferCentre: boolean): Vec2 {
    if (preferCentre && !this.centreClaimed.has(shaft.id)) {
      this.centreClaimed.add(shaft.id);
      return shaftSlot(shaft.rect, 0);
    }
    return shaftSlot(shaft.rect, this.nextShaftSlot(shaft.id));
  }

  /** Min corner of the next ground-mounted condenser pad (MEC-04 last resort) */
  nextGroundPad(w: number, d: number): Vec2 {
    const perRow = 8;
    const col = this.groundPadIndex % perRow;
    const row = Math.floor(this.groundPadIndex / perRow);
    this.groundPadIndex++;
    return [this.groundPadOrigin[0] + col * (w + 0.6), this.groundPadOrigin[1] + row * (d + 0.6)];
  }

  warn(msg: string): void { this.ctx.warnings.push(`MEC: ${msg}`); }

  apply(patternId: string, app: Omit<PatternApplication, 'patternId'>): void {
    const n = (this.patternCounts.get(patternId) ?? 0) + 1;
    this.patternCounts.set(patternId, n);
    if (n <= PATTERN_APP_CAP) this.patterns.push({ patternId, ...app });
  }

  /** Total recorded applications of a pattern (including those suppressed by the cap) */
  applicationCount(patternId: string): number { return this.patternCounts.get(patternId) ?? 0; }

  /** Add a trailing summary application for patterns whose per-unit trace was capped */
  finalizePatternTrace(): void {
    for (const [id, n] of this.patternCounts) {
      if (n > PATTERN_APP_CAP) {
        this.patterns.push({ patternId: id, params: { applications: n, traced: PATTERN_APP_CAP }, note: `${n} applications; trace capped at ${PATTERN_APP_CAP}` });
      }
    }
  }

  // --------------------------------------------------------------------------
  // Emission
  // --------------------------------------------------------------------------

  addEquipment(o: AddEquipmentOpts): MechEquipment {
    const map: IfcMap = { ...EQUIPMENT_IFC[o.type], ...(o.ifc ?? {}) };
    const id = this.ids.next(o.storey, 'EQP');
    const eq: MechEquipment = {
      id,
      storey: o.storey,
      type: o.type,
      roomId: o.roomId,
      unitId: o.unitId,
      position: [r3(o.position[0]), r3(o.position[1]), r3(o.position[2])],
      width: r3(o.width),
      depth: r3(o.depth),
      height: r3(o.height),
      rotation: o.rotation ?? 0,
      capacityKw: o.capacityKw === undefined ? undefined : r1(o.capacityKw),
    };
    this.equipment.push(eq);
    this.elements.push({
      id,
      discipline: 'mechanical',
      ifcType: map.ifcType,
      predefinedType: map.predefinedType,
      name: o.name ?? `${map.objectType ?? o.type} ${id}`,
      objectType: map.objectType,
      storey: o.storey,
      geometry: { kind: 'box', position: eq.position, width: eq.width, depth: eq.depth, height: eq.height, rotation: eq.rotation },
      psets: [formaPset({
        system: map.system,
        serves: o.serves ?? o.roomId ?? o.unitId ?? '',
        airflowLs: o.airflowLs,
        size: `${mm(eq.width)} × ${mm(eq.depth)} × ${mm(eq.height)} mm`,
        capacityKw: eq.capacityKw,
        equipmentType: o.type,
      })],
      color: EQUIPMENT_COLOR,
      system: systemId('mechanical', map.system),
      unitId: o.unitId,
      roomId: o.roomId,
      patterns: o.patterns,
      tags: o.tags,
    });
    return eq;
  }

  addTerminal(o: AddTerminalOpts): AirTerminal {
    const map = TERMINAL_IFC[o.type];
    const id = this.ids.next(o.storey, 'TERM');
    const w = o.width ?? 0.3;
    const d = o.depth ?? 0.3;
    const t: AirTerminal = {
      id,
      storey: o.storey,
      type: o.type,
      roomId: o.roomId,
      position: [r3(o.xy[0]), r3(o.xy[1]), r3(o.z)],
      width: r3(w),
      depth: r3(d),
      airflowLs: r1(o.airflowLs),
    };
    this.terminals.push(t);
    this.elements.push({
      id,
      discipline: 'mechanical',
      ifcType: 'IfcAirTerminal',
      predefinedType: map.predefinedType,
      name: o.name ?? `${o.type} ${id}`,
      objectType: o.type,
      storey: o.storey,
      // 50 mm face plate whose top sits on the ceiling plane
      geometry: { kind: 'box', position: [r3(o.xy[0] - w / 2), r3(o.xy[1] - d / 2), r3(o.z - 0.05)], width: r3(w), depth: r3(d), height: 0.05 },
      psets: [
        formaPset({ system: map.system, serves: o.roomId, airflowLs: t.airflowLs, size: `${mm(w)} × ${mm(d)} mm` }),
        { name: 'Pset_AirTerminalTypeCommon', properties: [{ name: 'AirflowType', value: map.airflowType }, { name: 'Shape', value: 'RECTANGULAR' }, { name: 'FaceType', value: o.type === 'supply-diffuser' ? 'FOURWAYPATTERN' : 'LOUVRES' }] },
      ],
      color: SYSTEM_COLOR[map.system] ?? EQUIPMENT_COLOR,
      system: systemId('mechanical', map.system),
      unitId: o.unitId,
      roomId: o.roomId,
      patterns: o.patterns,
      tags: ['terminal'],
    });
    return t;
  }

  addDuct(o: AddDuctOpts): DuctRun | null {
    const path = dedupe(o.path.map(p => [r3(p[0]), r3(p[1]), r3(p[2])] as Vec3), 0.05);
    if (path.length < 2) return null;
    const id = this.ids.next(o.storey, o.pipe ? 'PIPE' : 'DUCT');
    const sysKey: MechSystemKey = o.systemOverride ?? o.systemType;
    const run: DuctRun = {
      id,
      storey: o.storey,
      systemType: o.systemType,
      path,
      shape: o.shape,
      width: r3(o.width),
      height: r3(o.height),
      servesRoomIds: o.servesRoomIds ?? [],
      unitId: o.unitId,
    };
    // `ducts` is the AIR duct list; refrigerant / hydronic pipes appear only as elements.
    if (!o.pipe) this.ducts.push(run);

    const color = SYSTEM_COLOR[sysKey] ?? SYSTEM_COLOR.supply;
    const sizeText = o.shape === 'round' ? `Ø${mm(o.width)} mm` : `${mm(o.width)} × ${mm(o.height)} mm`;
    const profile = o.shape === 'round'
      ? { type: 'circle' as const, radius: r3(o.width / 2) }
      : { type: 'rect' as const, width: r3(o.width), height: r3(o.height) };
    const ifcType = o.pipe ? 'IfcPipeSegment' : 'IfcDuctSegment';
    const tags = [o.pipe ? 'pipe-segment' : 'duct-segment', ...(o.tags ?? [])];

    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      if (l <= 0.05) continue;
      this.ductLengthM += l;
      this.elements.push({
        id: `${id}-S${String(i).padStart(2, '0')}`,
        discipline: 'mechanical',
        ifcType,
        predefinedType: 'RIGIDSEGMENT',
        name: `${o.name ?? o.systemType} ${sizeText}`,
        objectType: o.systemType,
        storey: o.storey,
        geometry: { kind: 'axis', start: a, end: b, profile },
        psets: [
          formaPset({ system: sysKey, serves: (o.servesRoomIds ?? []).join(' '), airflowLs: o.airflowLs, size: sizeText }),
          o.pipe
            ? { name: 'Pset_PipeSegmentTypeCommon', properties: [{ name: 'NominalDiameter', value: r3(o.width) }] }
            : { name: 'Pset_DuctSegmentTypeCommon', properties: o.shape === 'round'
              ? [{ name: 'Shape', value: 'ROUND' }, { name: 'NominalDiameter', value: r3(o.width) }]
              : [{ name: 'Shape', value: 'RECTANGULAR' }, { name: 'NominalWidth', value: r3(o.width) }, { name: 'NominalHeight', value: r3(o.height) }] },
        ],
        quantities: [{ name: 'Qto_DuctSegmentBaseQuantities', quantities: [{ name: 'Length', value: r3(l), kind: 'IfcQuantityLength' }] }],
        color,
        system: systemId('mechanical', sysKey),
        unitId: o.unitId,
        patterns: o.patterns,
        tags,
      });
    }

    // Fittings at interior corners (skipped at detail 'low')
    if (this.detail !== 'low') {
      const fitSize = o.shape === 'round' ? Math.max(0.2, Math.min(0.3, o.width * 1.6)) : 0.3;
      for (let i = 1; i < path.length - 1; i++) {
        const c = path[i];
        this.elements.push({
          id: `${id}-B${String(i).padStart(2, '0')}`,
          discipline: 'mechanical',
          ifcType: o.pipe ? 'IfcPipeFitting' : 'IfcDuctFitting',
          predefinedType: 'BEND',
          name: `${o.systemType} bend`,
          objectType: o.systemType,
          storey: o.storey,
          geometry: { kind: 'box', position: [r3(c[0] - fitSize / 2), r3(c[1] - fitSize / 2), r3(c[2] - fitSize / 2)], width: r3(fitSize), depth: r3(fitSize), height: r3(fitSize) },
          psets: [formaPset({ system: sysKey, serves: '', size: sizeText })],
          color,
          system: systemId('mechanical', sysKey),
          unitId: o.unitId,
          patterns: o.patterns,
          tags: [o.pipe ? 'pipe-fitting' : 'duct-fitting'],
        });
      }
    }
    return run;
  }

  /**
   * A vertical riser inside a shaft. Emitted PER STOREY (one axis element per storey from
   * z = 0 to that storey's floor-to-floor height) because element Z is storey-local.
   */
  /** One riser per (shaft, system) — shared by every dwelling on the stack */
  ensureRiser(key: string, make: () => AddRiserOpts): Riser {
    const hit = this.riserByKey.get(key);
    if (hit) return hit;
    const r = this.addRiser(make());
    this.riserByKey.set(key, r);
    return r;
  }

  findRiser(key: string): Riser | null { return this.riserByKey.get(key) ?? null; }

  addRiser(o: AddRiserOpts): Riser {
    const id = this.ids.named('RISER', o.shaftId, (o.label ?? String(o.systemType)).toUpperCase());
    const riser: Riser = {
      id,
      shaftId: o.shaftId,
      systemType: o.systemType,
      fromStorey: o.fromStorey,
      toStorey: o.toStorey,
      xy: [r3(o.xy[0]), r3(o.xy[1])],
      width: r3(o.width),
      height: r3(o.height),
      shape: o.shape,
    };
    this.risers.push(riser);

    const isPipe = o.systemType === 'refrigerant' || o.systemType === 'hydronic';
    const sysKey: MechSystemKey = o.systemType as MechSystemKey;
    const color = SYSTEM_COLOR[sysKey] ?? SYSTEM_COLOR.supply;
    const sizeText = o.shape === 'round' ? `Ø${mm(o.width)} mm` : `${mm(o.width)} × ${mm(o.height)} mm`;
    const profile = o.shape === 'round'
      ? { type: 'circle' as const, radius: r3(o.width / 2) }
      : { type: 'rect' as const, width: r3(o.width), height: r3(o.height) };

    for (const st of this.riserSpan(o.fromStorey, o.toStorey)) {
      const top = r3(st.floorToFloor);
      if (top <= 0.05) continue;
      this.ductLengthM += top;
      this.elements.push({
        id: `${id}-${st.id}`,
        discipline: 'mechanical',
        ifcType: isPipe ? 'IfcPipeSegment' : 'IfcDuctSegment',
        predefinedType: 'RIGIDSEGMENT',
        name: `${o.systemType} riser ${sizeText}`,
        objectType: `${o.systemType}-riser`,
        storey: st.id,
        geometry: { kind: 'axis', start: [riser.xy[0], riser.xy[1], 0], end: [riser.xy[0], riser.xy[1], top], profile },
        psets: [formaPset({ system: sysKey, serves: o.serves ?? o.shaftId, airflowLs: o.airflowLs, size: sizeText })],
        quantities: [{ name: 'Qto_DuctSegmentBaseQuantities', quantities: [{ name: 'Length', value: top, kind: 'IfcQuantityLength' }] }],
        color,
        system: systemId('mechanical', sysKey),
        patterns: o.patterns,
        tags: ['riser', `shaft:${o.shaftId}`],
      });
    }
    return riser;
  }
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function push<T>(m: Map<string, T[]>, k: string, v: T): void {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}

function mm(m: number): number { return Math.round(m * 1000); }

export interface FormaPsetOpts {
  system: string;
  serves?: string;
  airflowLs?: number;
  size: string;
  capacityKw?: number;
  equipmentType?: string;
}

export function formaPset(o: FormaPsetOpts): PropertySetDef {
  const props = [
    { name: 'System', value: systemId('mechanical', o.system) },
    { name: 'ServesRooms', value: o.serves ?? '' },
    { name: 'AirflowLs', value: o.airflowLs === undefined ? 0 : r1(o.airflowLs) },
    { name: 'Size', value: o.size },
  ];
  if (o.capacityKw !== undefined) props.push({ name: 'CapacityKw', value: o.capacityKw });
  if (o.equipmentType) props.push({ name: 'EquipmentType', value: o.equipmentType });
  return { name: 'Forma_Mechanical', properties: props };
}

/** Largest duct depth that fits between the ceiling and the structure at a given centreline Z */
function fitDepth(wanted: number, z: number, ceilingZ: number, soffitZ: number): number {
  const below = Math.max(0.05, z - ceilingZ);
  const above = Math.max(0.05, soffitZ - z);
  return Math.max(0.1, Math.min(wanted, 2 * below, 2 * above));
}

/**
 * Dwelling duct band (pattern MEC-02 + coordination rule 7): the trunk hides in the hall
 * ceiling between `ceiling` and `floorToFloor - slabT - 0.05`. Sits tight under the
 * structure when the plenum allows it, otherwise sits on the ceiling and flags `tight`.
 */
export function unitDuctBand(f2f: number, slabT: number, ceiling: number, wantedDepth: number): { z: number; depth: number; tight: boolean } {
  const soffit = f2f - slabT;
  const available = soffit - 0.05 - ceiling;
  const depth = Math.min(wantedDepth, Math.max(0.1, available));
  if (available >= depth) return { z: soffit - 0.05 - depth / 2, depth, tight: false };
  return { z: ceiling + depth / 2, depth, tight: true };
}

