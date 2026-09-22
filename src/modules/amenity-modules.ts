/**
 * Amenity modules — the shared-program legos the ground floor and the amenity storey are packed from, plus the two
 * that absorb a declared remnant (`A-flex`, `A-store`). A remnant is only ever a remnant because it is NARROWER than
 * the smallest admissible dwelling module; giving it a module id keeps every slot in the floor document uniform and
 * lets the editor swap it for something else.
 */
import type { RoomType } from '../core/types.ts';
import type { AmenityModule, Port } from './types.ts';
import { amenityModuleId } from './ids.ts';

interface AmenitySpec {
  role: string;
  name: string;
  roomType: RoomType;
  frontage: { min: number; max: number };
  depth: { min: number; max: number };
  /** target area per dwelling served (m²/unit), 0 = fixed size */
  perUnit: number;
  area: number;
  daylit: boolean;
}

const ROOMS: AmenitySpec[] = [
  { role: 'lobby', name: 'Residential lobby', roomType: 'lobby', frontage: { min: 4.0, max: 12.0 }, depth: { min: 3.0, max: 9.0 }, perUnit: 0.30, area: 45, daylit: true },
  { role: 'mail', name: 'Mail & parcel room', roomType: 'mail', frontage: { min: 2.4, max: 6.0 }, depth: { min: 2.2, max: 5.0 }, perUnit: 0.10, area: 12, daylit: false },
  { role: 'parcel', name: 'Parcel lockers', roomType: 'mail', frontage: { min: 1.8, max: 4.5 }, depth: { min: 1.6, max: 3.5 }, perUnit: 0.06, area: 8, daylit: false },
  { role: 'bike', name: 'Bicycle store', roomType: 'bike-store', frontage: { min: 3.0, max: 12.0 }, depth: { min: 2.6, max: 8.0 }, perUnit: 0.60, area: 40, daylit: false },
  { role: 'gym', name: 'Residents gym', roomType: 'gym', frontage: { min: 4.0, max: 14.0 }, depth: { min: 3.4, max: 10.0 }, perUnit: 0.45, area: 60, daylit: true },
  { role: 'lounge', name: 'Residents lounge', roomType: 'lounge', frontage: { min: 3.6, max: 14.0 }, depth: { min: 3.0, max: 10.0 }, perUnit: 0.50, area: 55, daylit: true },
  { role: 'coworking', name: 'Co-working room', roomType: 'amenity', frontage: { min: 3.4, max: 12.0 }, depth: { min: 3.0, max: 9.0 }, perUnit: 0.35, area: 45, daylit: true },
  { role: 'dining-hall', name: 'Shared dining hall', roomType: 'dining-hall', frontage: { min: 4.0, max: 14.0 }, depth: { min: 3.4, max: 10.0 }, perUnit: 0.80, area: 50, daylit: true },
  { role: 'laundry', name: 'Shared laundry', roomType: 'laundry', frontage: { min: 2.4, max: 7.0 }, depth: { min: 2.2, max: 5.0 }, perUnit: 0.15, area: 18, daylit: false },
  { role: 'flex', name: 'Flexible room', roomType: 'flex', frontage: { min: 2.8, max: 9.0 }, depth: { min: 2.4, max: 12.0 }, perUnit: 0, area: 14, daylit: true },
  { role: 'store', name: 'Resident store', roomType: 'storage', frontage: { min: 0.8, max: 9.0 }, depth: { min: 0.8, max: 12.0 }, perUnit: 0, area: 6, daylit: false },
];

export const AMENITY_AREA: Record<string, number> =
  ROOMS.reduce<Record<string, number>>((m, r) => { m[r.role] = r.area; return m; }, {});
export const AMENITY_PER_UNIT: Record<string, number> =
  ROOMS.reduce<Record<string, number>>((m, r) => { m[r.role] = r.perUnit; return m; }, {});

/** The module a declared remnant becomes: a flexible room when it is usable, otherwise a store (design §4.6 phase 3) */
export function remnantModuleId(width: number): string {
  return width >= 3.0 ? amenityModuleId('flex') : amenityModuleId('store');
}

export function buildAmenityModules(): AmenityModule[] {
  return ROOMS.map(r => ({
    id: amenityModuleId(r.role),
    kind: 'amenity' as const,
    name: r.name,
    frontage: r.frontage,
    depth: r.depth,
    ports: [
      { id: 'door', kind: 'entry', side: 'front', atFrac: 0.5, width: r.frontage.min >= 3 ? 1.2 : 0.9, required: true },
      ...(r.daylit
        ? [{ id: 'daylight', kind: 'daylight' as const, side: 'rear' as const, atFrac: 0.5, width: 1.5, required: true }]
        : []),
    ] as Port[],
    mirrorable: true,
    patterns: r.role === 'lobby' ? ['ARC-31'] : ['ARC-31', 'ARC-35'],
    role: r.role,
    roomType: r.roomType,
  }));
}
