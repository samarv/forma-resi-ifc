/**
 * Parking modules. A parking deck is packed from bays ACROSS the structure, not from loose stalls:
 *   double-loaded  2 × 5.4 m stalls either side of a 6.0 m aisle = 16.8 m across
 *   single-loaded  5.4 m stalls + 6.0 m aisle                   = 11.4 m across
 *   ramp           a 1:8 (12.5 %) straight ramp with its 6.0 m running width
 * `stallPitch` is the along-bay spacing of one stall (2.6 m standard, 3.6 m accessible).
 */
import type { ParkingModule, Port } from './types.ts';
import { parkingModuleId } from './ids.ts';

export const STALL = { width: 2.6, length: 5.4, aisle: 6.0, accessible: 3.6 };

export function buildParkingModules(): ParkingModule[] {
  const double: ParkingModule = {
    id: parkingModuleId('double-loaded', 90),
    kind: 'parking',
    name: 'Double-loaded parking bay',
    // along the bay: at least one stall pitch, up to a full 60 m aisle run
    frontage: { min: STALL.width, max: 60 },
    depth: { min: 2 * STALL.length + STALL.aisle, max: 2 * STALL.length + STALL.aisle + 1.2 },
    ports: [
      { id: 'aisle.a', kind: 'ramp', side: 'left', atFrac: 0.5, width: STALL.aisle, required: true },
      { id: 'aisle.b', kind: 'ramp', side: 'right', atFrac: 0.5, width: STALL.aisle, required: false },
    ] as Port[],
    mirrorable: false,
    patterns: ['SIT-06', 'STR-04'],
    role: 'double-loaded',
    bayAcross: round3(2 * STALL.length + STALL.aisle),
    stallPitch: STALL.width,
    aisle: STALL.aisle,
  };
  const single: ParkingModule = {
    ...double,
    id: parkingModuleId('single-loaded', 90),
    name: 'Single-loaded parking bay',
    depth: { min: STALL.length + STALL.aisle, max: STALL.length + STALL.aisle + 1.2 },
    role: 'single-loaded',
    bayAcross: round3(STALL.length + STALL.aisle),
  };
  const ramp: ParkingModule = {
    id: parkingModuleId('ramp'),
    kind: 'parking',
    name: 'Parking ramp',
    frontage: { min: 6.0, max: 40 },
    depth: { min: STALL.aisle, max: 7.5 },
    ports: [
      { id: 'top', kind: 'ramp', side: 'front', atFrac: 0.5, width: STALL.aisle, required: true },
      { id: 'bottom', kind: 'ramp', side: 'rear', atFrac: 0.5, width: STALL.aisle, required: true },
    ] as Port[],
    mirrorable: false,
    patterns: ['SIT-06'],
    role: 'ramp',
    bayAcross: STALL.aisle,
    stallPitch: 0,
    aisle: STALL.aisle,
    rampSlope: 0.125,
  };
  return [double, single, ramp];
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
