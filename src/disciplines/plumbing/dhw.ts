/**
 * Step 4 — domestic hot water (PLB-04 Hot Water Close to the Tap).
 *
 * 'per-unit-tank'     → a storage water heater in each dwelling's utility/laundry/closet corner
 * 'per-unit-tankless' → a wall-hung instantaneous heater at z 1.2 in the utility/kitchen
 * 'central-plant'     → storage tanks + circulators in the ground-floor water room, an HWR return
 *                       riding every stack and HWR/DHW mains in the corridor pipe lane
 * 'heat-network'      → as central-plant, but the per-dwelling heat interface units belong to
 *                       mechanical; plumbing provides storage, circulators and the mains only.
 */
import type { ArchModel, DhwSystemId, RoomDef, Vec2, Vec3 } from '../../core/types.ts';
import { dist, rectCenter, round } from '../../core/geometry.ts';
import { manhattanLink } from './routing.ts';
import {
  addFixture, emitRun, warn, bump, info, DCW_BRANCH_Z, DHW_BRANCH_Z,
  type PlumbState, type StackInfo,
} from './state.ts';
import { furnitureCenter } from './fixtures.ts';
import { stackXY } from './stacks.ts';

const HEATER_ROOM_PREFERENCE = [
  'laundry', 'utility', 'storage', 'closet', 'walk-in-closet', 'hall', 'entry',
  'bathroom', 'kitchen', 'living-kitchen', 'ensuite',
];

const PLANT_ROOM_PREFERENCE = ['water-room', 'mech-room', 'plant', 'utility', 'basement', 'garage', 'storage'];

export interface DhwResult {
  storageL: number;
  central: boolean;
  plantRoomId?: string;
  /** Corridor mains the service step must run for this DHW strategy */
  corridorSystems: ('dhw' | 'hwr')[];
}

/** Find the room of a unit best suited to a water heater */
function heaterRoom(unit: { roomIds: string[] }, roomById: Map<string, RoomDef>, storey: string): RoomDef | null {
  const rooms = unit.roomIds.map(id => roomById.get(id)).filter((r): r is RoomDef => !!r && r.storey === storey);
  for (const type of HEATER_ROOM_PREFERENCE) {
    const hit = rooms.find(r => r.type === type && r.area > 1.2);
    if (hit) return hit;
  }
  return rooms.sort((a, b) => b.area - a.area)[0] ?? null;
}

/** Corner of `room` closest to `target`, inset so the box stays inside the room */
function cornerNear(room: RoomDef, target: Vec2, w: number, d: number): Vec2 {
  const r = room.rect;
  const cx = [r.x + w / 2 + 0.05, r.x + r.w - w / 2 - 0.05];
  const cy = [r.y + d / 2 + 0.05, r.y + r.h - d / 2 - 0.05];
  let best: Vec2 = [Math.min(cx[0], cx[1]), Math.min(cy[0], cy[1])];
  let bd = Infinity;
  for (const x of cx) {
    for (const y of cy) {
      const p: Vec2 = [x, y];
      const dd = dist(p, target);
      if (dd < bd) { bd = dd; best = p; }
    }
  }
  return best;
}

function nearestStack(st: PlumbState, unitId: string, p: Vec2): StackInfo | null {
  let best: StackInfo | null = null;
  let bd = Infinity;
  for (const si of st.stacks) {
    const own = si.stack.servesUnitIds.includes(unitId);
    const d = dist(si.stack.xy as Vec2, p) - (own ? 100 : 0);
    if (d < bd) { bd = d; best = si; }
  }
  return best;
}

export function buildDhw(st: PlumbState): DhwResult {
  const arch = st.ctx.arch as ArchModel;
  const dhw: DhwSystemId = st.ctx.typology.dhw;
  const central = dhw === 'central-plant' || dhw === 'heat-network';
  const roomById = new Map(arch.rooms.map(r => [r.id, r] as const));
  const occupants = arch.units.reduce((s, u) => s + (u.occupants || 0), 0);

  if (!central) {
    const tankless = dhw === 'per-unit-tankless';
    const heaterFurniture = new Map<string, ReturnType<typeof furnitureCenter>>();
    const heaterRot = new Map<string, number>();
    for (const f of arch.furniture) {
      if (f.type !== 'water-heater' || !f.unitId) continue;
      heaterFurniture.set(`${f.unitId}|${f.storey}`, furnitureCenter(f));
      heaterRot.set(`${f.unitId}|${f.storey}`, f.rotation);
    }
    let placed = 0;
    for (const unit of arch.units) {
      const storey = unit.storeys[0] ?? st.groundStorey;
      const key = `${unit.id}|${storey}`;
      const size: [number, number, number] = tankless ? [0.4, 0.25, 0.6] : [0.6, 0.6, 1.5];
      let center = heaterFurniture.get(key);
      let rotation = heaterRot.get(key) ?? 0;
      let roomId: string | undefined;
      if (!center) {
        const room = heaterRoom(unit, roomById, storey);
        if (!room) continue;
        roomId = room.id;
        const target = nearestStack(st, unit.id, rectCenter(room.rect));
        center = cornerNear(room, target ? (target.stack.xy as Vec2) : rectCenter(room.rect), size[0], size[1]);
        rotation = 0;
      } else {
        roomId = arch.rooms.find(r => r.storey === storey && r.unitId === unit.id
          && center![0] >= r.rect.x && center![0] <= r.rect.x + r.rect.w
          && center![1] >= r.rect.y && center![1] <= r.rect.y + r.rect.h)?.id;
      }
      const baseZ = tankless ? 1.2 : 0.0;
      const fixture = addFixture(st, {
        type: 'water-heater',
        storey,
        center: [center[0], center[1], baseZ],
        rotation,
        roomId,
        unitId: unit.id,
        width: size[0], depth: size[1], height: size[2],
        ifcType: tankless ? 'IfcUnitaryEquipment' : 'IfcTank',
        predefinedType: tankless ? undefined : 'STORAGE',
        objectType: tankless ? 'Tankless water heater' : 'Water heater',
        name: tankless ? 'Tankless water heater' : 'Storage water heater (190 l)',
        solid: true,
        patterns: ['PLB-04'],
        extraProps: [
          { name: 'DhwStrategy', value: dhw },
          { name: 'StorageLitres', value: tankless ? 0 : 190 },
          { name: 'HeightZ', value: baseZ },
        ],
      });
      // connect to the unit's stack: cold in at the bottom, hot out at the top
      const si = nearestStack(st, unit.id, center);
      if (si) {
        const cold = stackXY(si, 'dcw');
        const hot = stackXY(si, 'dhw');
        const inletZ = tankless ? baseZ + 0.1 : baseZ + size[2] - 0.15;
        // L-shaped in the wall / ceiling void, then a single vertical leg into the heater
        const pathIn: Vec3[] = [
          ...manhattanLink([cold[0], cold[1], DCW_BRANCH_Z], [center[0], center[1], DCW_BRANCH_Z], 'x'),
          [center[0], center[1], inletZ],
        ];
        emitRun(st, {
          storey, system: 'dcw', diameter: 0.025, path: pathIn,
          servesFixtureIds: [fixture.id], unitId: unit.id, roomId, stackId: si.stack.id,
          name: 'Water heater cold feed Ø25', patterns: ['PLB-04'],
        });
        const pathOut: Vec3[] = [
          [center[0], center[1], inletZ + 0.05],
          ...manhattanLink([center[0], center[1], DHW_BRANCH_Z], [hot[0], hot[1], DHW_BRANCH_Z], 'x'),
        ];
        emitRun(st, {
          storey, system: 'dhw', diameter: 0.025, path: pathOut,
          servesFixtureIds: [fixture.id], unitId: unit.id, roomId, stackId: si.stack.id,
          name: 'Water heater hot outlet Ø25', patterns: ['PLB-04'],
        });
      }
      placed++;
      bump(st, 'waterHeaters');
    }
    st.apps.push({
      patternId: 'PLB-04',
      params: {
        strategy: dhw,
        heaters: placed,
        storagePerDwellingL: tankless ? 0 : 190,
        maxDeadLegM: 15,
        note: 'source inside the dwelling — dead legs are short by construction',
      },
    });
    if (placed === 0) warn(st, 'noheater', `no water heaters could be placed for a '${dhw}' system`);
    return { storageL: tankless ? 0 : 190 * placed, central: false, corridorSystems: [] };
  }

  // --- central plant --------------------------------------------------------
  const plantRoom = findPlantRoom(st, arch);
  if (!plantRoom) {
    warn(st, 'noplant', `no water/mech room found on ${st.groundStorey} for the central DHW plant; plant omitted`);
    return { storageL: 0, central: true, corridorSystems: ['dhw', 'hwr'] };
  }
  const storageL = Math.max(500, Math.round(occupants * (dhw === 'heat-network' ? 25 : 40)));
  const tankCount = 2;
  const c = rectCenter(plantRoom.rect);
  const tankW = Math.min(1.2, Math.max(0.8, plantRoom.rect.w / 4));
  for (let i = 0; i < tankCount; i++) {
    const p: Vec2 = [c[0] + (i - (tankCount - 1) / 2) * (tankW + 0.25), c[1]];
    addFixture(st, {
      type: 'water-heater',
      storey: plantRoom.storey,
      center: [p[0], p[1], 0],
      roomId: plantRoom.id,
      width: tankW, depth: tankW, height: 2.0,
      ifcType: 'IfcTank', predefinedType: 'STORAGE',
      objectType: dhw === 'heat-network' ? 'DHW buffer vessel' : 'DHW storage calorifier',
      name: `DHW storage tank ${i + 1} (${Math.round(storageL / tankCount)} l)`,
      solid: true, patterns: ['PLB-04'],
      extraProps: [
        { name: 'DhwStrategy', value: dhw },
        { name: 'StorageLitres', value: Math.round(storageL / tankCount) },
        { name: 'StorageTemperatureC', value: 60 },
      ],
    });
    bump(st, 'dhwTanks');
  }
  for (let i = 0; i < 2; i++) {
    const p: Vec2 = [c[0] + (i - 0.5) * 0.8, c[1] + tankW / 2 + 0.6];
    st.elements.push({
      id: st.ids.next(plantRoom.storey, 'PUMP'),
      discipline: 'plumbing',
      ifcType: 'IfcPump',
      predefinedType: 'CIRCULATOR',
      name: `DHW recirculation pump ${i + 1}${i === 1 ? ' (standby)' : ''}`,
      objectType: 'Hot water circulator',
      storey: plantRoom.storey,
      geometry: { kind: 'box', position: [round(p[0] - 0.2), round(p[1] - 0.15), 0.1], width: 0.4, depth: 0.3, height: 0.35 },
      psets: [{
        name: 'Forma_Plumbing',
        properties: [
          { name: 'System', value: 'Hot water recirculation' },
          { name: 'Duty', value: i === 0 ? 'duty' : 'standby' },
          { name: 'ReturnTemperatureC', value: 50 },
        ],
      }],
      color: [0.95, 0.55, 0.2],
      roomId: plantRoom.id,
      patterns: ['PLB-04'],
    });
    bump(st, 'dhwPumps');
  }
  if (dhw === 'heat-network') {
    warn(st, 'hiu', 'heat-network DHW: per-dwelling heat interface units are placed by mechanical (MechEquipment type \'heat-interface-unit\'); plumbing provides storage, circulators, risers and mains only');
  }
  st.apps.push({
    patternId: 'PLB-04',
    storey: plantRoom.storey,
    params: {
      strategy: dhw,
      plantRoomId: plantRoom.id,
      storageL,
      tanks: tankCount,
      circulators: 2,
      storageTemperatureC: 60,
      returnTemperatureC: 50,
      maxDeadLegM: 15,
    },
    note: 'HWR recirculation riser on every stack keeps dead legs under 15 m',
  });
  return { storageL, central: true, plantRoomId: plantRoom.id, corridorSystems: ['dhw', 'hwr'] };
}

/** Ground-floor room for the incoming service / central plant */
export function findPlantRoom(st: PlumbState, arch: ArchModel): RoomDef | null {
  const ground = st.groundStorey;
  const onGround = arch.rooms.filter(r => r.storey === ground);
  for (const type of PLANT_ROOM_PREFERENCE) {
    const hit = onGround.filter(r => r.type === type).sort((a, b) => b.area - a.area)[0];
    if (hit) return hit;
  }
  const lobby = onGround.filter(r => r.type === 'lobby' || r.type === 'lift-lobby' || r.type === 'entry')
    .sort((a, b) => b.area - a.area)[0];
  if (lobby) return lobby;
  // last resort: the largest common room on the ground floor
  const plan = info(st, ground).plan;
  const common = (plan?.commonRoomIds ?? []).map(id => arch.rooms.find(r => r.id === id))
    .filter((r): r is RoomDef => !!r).sort((a, b) => b.area - a.area)[0];
  return common ?? onGround.sort((a, b) => b.area - a.area)[0] ?? null;
}
