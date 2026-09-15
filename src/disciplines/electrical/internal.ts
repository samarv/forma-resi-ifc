/**
 * Working state shared by the electrical sub-generators: index maps over the upstream models,
 * the resolved region preset, and the accumulating device / panel / circuit lists.
 *
 * ANCHOR CONVENTION (see catalog.ts): ElecDevice.position and ElecPanel.position are ANCHORS,
 * not box corners — a point on the inside wall face at the device's vertical centre for
 * wall-mounted items, the fixture centre at the ceiling for ceiling items, the footprint centre
 * at floor level for free-standing items. emit.ts converts an anchor into a `box` geometry.
 */
import type {
  ArchModel, CableTrayRun, Circuit, CorridorDef, DoorDef, ElecDevice, ElecDeviceType, ElecPanel,
  ElecRiser, FloorPlan, FurnitureDef, GenContext, ModelElement, PatternApplication, RGB, RoomDef,
  StoreyDef, UnitInstance, Vec2, Vec3, WallDef, WindowDef,
} from '../../core/types.ts';
import { IdFactory } from '../../core/ids.ts';
import { DEVICE_SPEC, type ElecSystem } from './catalog.ts';
import type { ElecRegionPreset } from './region.ts';
import { roomFaces, type RoomFace } from './placement.ts';

export interface DeviceExtra {
  va: number;
  lumens: number;
  /** circuit type this device wants to land on */
  want: Circuit['type'] | null;
  name: string;
  /** free-form note recorded in the pset */
  note?: string;
}

export interface UnitContext {
  unit: UnitInstance;
  storey: string;
  rooms: RoomDef[];
  roomById: Map<string, RoomDef>;
  furniture: FurnitureDef[];
  entryDoor: DoorDef | null;
  hasGarage: boolean;
  hasEv: boolean;
  fuelAppliance: boolean;
  areaM2: number;
}

/** A straight run (tray / conduit / busduct) queued for emission as an `axis` element */
export interface RunDraft {
  id: string;
  storey: string;
  name: string;
  start: Vec3;
  end: Vec3;
  profile: { type: 'circle'; radius: number } | { type: 'rect'; width: number; height: number };
  ifcType: string;
  predefinedType?: string;
  objectType?: string;
  color: RGB;
  system: ElecSystem;
  unitId?: string;
  roomId?: string;
  note?: string;
  patterns: string[];
  lengthM: number;
}

export interface ElecCtx {
  ctx: GenContext;
  arch: ArchModel;
  ids: IdFactory;
  region: ElecRegionPreset;
  detail: 'low' | 'medium' | 'high';
  /** above-grade residential storeys in order */
  storeys: StoreyDef[];
  storeyById: Map<string, StoreyDef>;
  floorByStorey: Map<string, FloorPlan>;
  roomById: Map<string, RoomDef>;
  wallById: Map<string, WallDef>;
  doorById: Map<string, DoorDef>;
  doorsByWall: Map<string, DoorDef[]>;
  windowsByWall: Map<string, WindowDef[]>;
  roomsByStorey: Map<string, RoomDef[]>;
  furnByRoom: Map<string, FurnitureDef[]>;
  unitById: Map<string, UnitInstance>;
  facesCache: Map<string, RoomFace[]>;
  devices: ElecDevice[];
  panels: ElecPanel[];
  circuits: Circuit[];
  trays: CableTrayRun[];
  risers: ElecRiser[];
  runs: RunDraft[];
  elements: ModelElement[];
  patterns: PatternApplication[];
  extra: Map<string, DeviceExtra>;
  /** device ids grouped by (roomId → lighting group) for switch wiring */
  lightGroups: Map<string, string[]>;
  warnings: string[];
  conduitLengthM: number;
}

export function makeElecCtx(ctx: GenContext, arch: ArchModel, region: ElecRegionPreset): ElecCtx {
  const ec: ElecCtx = {
    ctx,
    arch,
    ids: new IdFactory('electrical'),
    region,
    detail: ctx.spec.options.detail,
    storeys: ctx.storeys.filter(s => s.index >= 0 && s.index < 100),
    storeyById: new Map(ctx.storeys.map(s => [s.id, s])),
    floorByStorey: new Map(arch.floors.map(f => [f.storey, f])),
    roomById: new Map(arch.rooms.map(r => [r.id, r])),
    wallById: new Map(arch.walls.map(w => [w.id, w])),
    doorById: new Map(arch.doors.map(d => [d.id, d])),
    doorsByWall: new Map(),
    windowsByWall: new Map(),
    roomsByStorey: new Map(),
    furnByRoom: new Map(),
    unitById: new Map(arch.units.map(u => [u.id, u])),
    facesCache: new Map(),
    devices: [],
    panels: [],
    circuits: [],
    trays: [],
    risers: [],
    runs: [],
    elements: [],
    patterns: [],
    extra: new Map(),
    lightGroups: new Map(),
    warnings: ctx.warnings,
    conduitLengthM: 0,
  };
  for (const d of arch.doors) push(ec.doorsByWall, d.wallId, d);
  for (const w of arch.windows) push(ec.windowsByWall, w.wallId, w);
  for (const r of arch.rooms) push(ec.roomsByStorey, r.storey, r);
  for (const f of arch.furniture) push(ec.furnByRoom, f.roomId, f);
  return ec;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

export function facesOf(ec: ElecCtx, room: RoomDef): RoomFace[] {
  const hit = ec.facesCache.get(room.id);
  if (hit) return hit;
  const f = roomFaces(room, ec.wallById);
  ec.facesCache.set(room.id, f);
  return f;
}

export function doorsOfRoom(ec: ElecCtx, room: RoomDef): DoorDef[] {
  const out: DoorDef[] = [];
  for (const id of room.doorIds) {
    const d = ec.doorById.get(id);
    if (d) out.push(d);
  }
  return out;
}

export function doorsOnFace(ec: ElecCtx, face: RoomFace): DoorDef[] {
  return face.wallId ? (ec.doorsByWall.get(face.wallId) ?? []) : [];
}

export function windowsOnFace(ec: ElecCtx, face: RoomFace): WindowDef[] {
  return face.wallId ? (ec.windowsByWall.get(face.wallId) ?? []) : [];
}

export interface AddDeviceOpts {
  roomId?: string;
  unitId?: string;
  wallId?: string;
  va?: number;
  watts?: number;
  lumens?: number;
  want?: Circuit['type'] | null;
  name?: string;
  note?: string;
  group?: string;
}

/** Register a device. `anchor` follows the mount convention of DEVICE_SPEC[type].mount. */
export function addDevice(
  ec: ElecCtx,
  storey: string,
  type: ElecDeviceType,
  anchor: Vec3,
  rotation: number,
  opts: AddDeviceOpts = {},
): ElecDevice {
  const spec = DEVICE_SPEC[type];
  const dev: ElecDevice = {
    id: ec.ids.next(storey, spec.kind),
    storey,
    type,
    roomId: opts.roomId,
    unitId: opts.unitId,
    wallId: opts.wallId,
    position: [round3(anchor[0]), round3(anchor[1]), round3(anchor[2])],
    rotation: round4(rotation),
    watts: opts.watts ?? Math.max(0, spec.watts),
  };
  ec.devices.push(dev);
  ec.extra.set(dev.id, {
    va: opts.va ?? spec.va,
    lumens: opts.lumens ?? spec.lumens ?? 0,
    want: opts.want ?? null,
    name: opts.name ?? spec.name,
    note: opts.note,
  });
  if (opts.group) {
    const g = ec.lightGroups.get(opts.group);
    if (g) g.push(dev.id);
    else ec.lightGroups.set(opts.group, [dev.id]);
  }
  return dev;
}

export interface AddPanelOpts {
  roomId?: string;
  unitId?: string;
  amps: number;
  voltage: string;
  circuitCount?: number;
}

export function addPanel(
  ec: ElecCtx,
  storey: string,
  type: ElecPanel['type'],
  anchor: Vec3,
  rotation: number,
  size: { w: number; d: number; h: number },
  opts: AddPanelOpts,
): ElecPanel {
  const panel: ElecPanel = {
    id: ec.ids.next(storey, panelKind(type)),
    storey,
    type,
    roomId: opts.roomId,
    unitId: opts.unitId,
    position: [round3(anchor[0]), round3(anchor[1]), round3(anchor[2])],
    rotation: round4(rotation),
    width: size.w,
    depth: size.d,
    height: size.h,
    amps: opts.amps,
    voltage: opts.voltage,
    circuitCount: opts.circuitCount ?? 0,
  };
  ec.panels.push(panel);
  return panel;
}

function panelKind(t: ElecPanel['type']): string {
  switch (t) {
    case 'unit-panel': return 'PNL';
    case 'main-switchboard': return 'MSB';
    case 'meter-bank': return 'MTR';
    case 'house-panel': return 'HPN';
    case 'floor-distribution': return 'FDB';
    case 'ev-panel': return 'EVP';
    case 'pv-combiner': return 'PVC';
  }
}

export type RunKind = 'tray' | 'data-tray' | 'busduct' | 'conduit' | 'lateral';

const RUN_IDKIND: Record<RunKind, string> = {
  tray: 'TRAY', 'data-tray': 'DTRY', busduct: 'BUSD', conduit: 'COND', lateral: 'SRVC',
};

/** Queue a straight run; returns its element id */
export function addRun(
  ec: ElecCtx,
  kind: RunKind,
  storey: string,
  start: Vec3,
  end: Vec3,
  draft: Omit<RunDraft, 'id' | 'storey' | 'start' | 'end' | 'lengthM'>,
): RunDraft {
  const lengthM = Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]);
  const run: RunDraft = {
    ...draft,
    id: lengthM < 1e-3 ? '' : ec.ids.next(storey, RUN_IDKIND[kind]),
    storey,
    start: [round3(start[0]), round3(start[1]), round3(start[2])],
    end: [round3(end[0]), round3(end[1]), round3(end[2])],
    lengthM: round3(lengthM),
  };
  // a degenerate run has no geometry to write
  if (run.id !== '') ec.runs.push(run);
  return run;
}

export function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
export function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

export function extraOf(ec: ElecCtx, id: string): DeviceExtra {
  return ec.extra.get(id) ?? { va: 0, lumens: 0, want: null, name: '' };
}

/** Ceiling height of the room, falling back to the storey's floor plan / floor-to-floor */
export function ceilingOf(ec: ElecCtx, room: RoomDef): number {
  if (room.height && room.height > 1.5) return room.height;
  const fp = ec.floorByStorey.get(room.storey);
  if (fp?.ceilingHeight) return fp.ceilingHeight;
  const st = ec.storeyById.get(room.storey);
  return Math.max(2.3, (st?.height ?? 3.0) - 0.45);
}

export function corridorsOf(ec: ElecCtx, storey: string): CorridorDef[] {
  return ec.floorByStorey.get(storey)?.corridors ?? [];
}

export function xy(p: Vec3): Vec2 {
  return [p[0], p[1]];
}

export function record(ec: ElecCtx, app: PatternApplication): void {
  ec.patterns.push(app);
}
