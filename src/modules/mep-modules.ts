/**
 * MEP room modules. Each one carries the PLACEMENT CONSTRAINTS that decide where the placer may put it, instead of
 * those constraints living as prose in the ground-floor program: a switchroom wants the street face and nothing wet
 * above it, a sump wants the lowest point of the building, a generator wants an external door and a vent path.
 */
import type { RoomType } from '../core/types.ts';
import type { MEPRoomModule, MEPRoomRole, Port } from './types.ts';
import { mepModuleId } from './ids.ts';

interface MEPSpec {
  role: MEPRoomRole;
  name: string;
  roomType: RoomType;
  frontage: { min: number; max: number };
  depth: { min: number; max: number };
  constraints: MEPRoomModule['constraints'];
  /** areas in m² used to size the room when the placer has a free interval */
  area: number;
}

const ROOMS: MEPSpec[] = [
  {
    role: 'switchroom', name: 'Utility switch room', roomType: 'elec-room',
    frontage: { min: 3.0, max: 6.5 }, depth: { min: 2.8, max: 6.0 }, area: 16,
    constraints: { streetSide: true, noWetAbove: true, externalDoor: true },
  },
  {
    role: 'water-entry', name: 'Water entry / meter room', roomType: 'water-room',
    frontage: { min: 2.4, max: 4.5 }, depth: { min: 2.2, max: 4.0 }, area: 9,
    constraints: { streetSide: true, externalDoor: true },
  },
  {
    role: 'fire-pump', name: 'Fire pump room', roomType: 'plant',
    frontage: { min: 3.0, max: 5.5 }, depth: { min: 2.8, max: 5.0 }, area: 14,
    constraints: { externalDoor: true, noWetAbove: true },
  },
  {
    role: 'generator', name: 'Standby generator', roomType: 'plant',
    frontage: { min: 3.5, max: 7.0 }, depth: { min: 3.0, max: 6.0 }, area: 20,
    constraints: { externalDoor: true, ventToOutside: true, noWetAbove: true },
  },
  {
    role: 'trash', name: 'Refuse & recycling', roomType: 'trash',
    frontage: { min: 3.0, max: 7.5 }, depth: { min: 2.8, max: 6.0 }, area: 18,
    constraints: { externalDoor: true, ventToOutside: true },
  },
  {
    role: 'sump', name: 'Sump / ejector pit', roomType: 'plant',
    frontage: { min: 1.8, max: 3.2 }, depth: { min: 1.8, max: 3.0 }, area: 5,
    constraints: { lowestPoint: true },
  },
  {
    role: 'mech-room', name: 'Mechanical room', roomType: 'mech-room',
    frontage: { min: 3.0, max: 8.0 }, depth: { min: 2.8, max: 7.0 }, area: 22,
    constraints: { ventToOutside: true },
  },
  {
    role: 'elec-room', name: 'Electrical room', roomType: 'elec-room',
    frontage: { min: 2.4, max: 5.0 }, depth: { min: 2.4, max: 5.0 }, area: 14,
    constraints: { noWetAbove: true },
  },
];

export const MEP_AREA: Record<MEPRoomRole, number> =
  ROOMS.reduce((m, r) => { m[r.role] = r.area; return m; }, {} as Record<MEPRoomRole, number>);

export function buildMEPModules(): MEPRoomModule[] {
  return ROOMS.map(r => ({
    id: mepModuleId(r.role),
    kind: 'mep' as const,
    name: r.name,
    frontage: r.frontage,
    depth: r.depth,
    ports: [
      { id: 'door', kind: 'entry', side: 'front', atFrac: 0.5, width: 1.0, required: true },
      ...(r.constraints.externalDoor
        ? [{ id: 'external', kind: 'entry' as const, side: 'rear' as const, atFrac: 0.5, width: 1.2, required: false }]
        : []),
      ...(r.constraints.ventToOutside
        ? [{ id: 'vent', kind: 'exhaust' as const, side: 'rear' as const, atFrac: 0.35, width: 0.6, required: true }]
        : []),
      { id: 'riser', kind: 'riser', side: 'interior', atFrac: 0.5, width: 0, required: false },
    ] as Port[],
    mirrorable: true,
    patterns: ['ARC-35', 'XD-04'],
    role: r.role,
    roomType: r.roomType,
    constraints: r.constraints,
  }));
}
