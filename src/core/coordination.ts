/**
 * Cross-discipline coordination rules (implements pattern XD-02 Corridor Service Spine).
 * Every MEP discipline uses these lanes so runs never clash with each other or with structure.
 *
 * Vertical bands in a corridor ceiling plenum (all storey-local Z, measured from THIS storey's floor):
 *
 *   floorToFloor ─────────────────────────── underside of slab above = floorToFloor - slabT
 *                 beam zone (if beams)        [soffit - beamDepth, soffit]
 *                 duct band                   top of duct = soffit - beamDepth - 0.05
 *                 pipe / tray band            below ducts, sprinkler main at same height as pipes
 *   ceiling ──────────────────────────────── corridor ceiling height (ceilingHeight)
 */
import type { Vec2, Vec3, Segment2 } from './types.ts';
import { add, scale, perp, segDir } from './geometry.ts';

export interface PlenumBands {
  soffitZ: number;
  /** Z of duct centreline */
  ductZ: number;
  /** Z of wet pipe centrelines (DCW/DHW/waste mains) */
  pipeZ: number;
  /** Z of sprinkler main centreline */
  sprinklerZ: number;
  /** Z of cable tray centreline */
  trayZ: number;
  /** Corridor ceiling height */
  ceilingZ: number;
  plenumDepth: number;
}

export interface LaneOffsets {
  /** Lateral offsets from the corridor centreline, positive = toward the corridor's left side (left of centreline direction) */
  duct: number;
  pipe: number;
  sprinkler: number;
  tray: number;
}

export const DEFAULT_LANES: LaneOffsets = { duct: 0, pipe: -0.35, sprinkler: -0.15, tray: 0.35 };

export function plenumBands(floorToFloor: number, slabT: number, beamDepth: number, corridorCeiling: number): PlenumBands {
  const soffitZ = floorToFloor - slabT;
  const structureBottom = soffitZ - beamDepth;
  // 300 mm deep duct with a 50 mm gap under structure, but never below the ceiling + 150 mm
  const ductZ = Math.max(structureBottom - 0.05 - 0.15, corridorCeiling + 0.15);
  // Wet pipes / sprinkler main / cable tray share a band 250 mm below the duct axis, never below ceiling + 50 mm
  const pipeZ = Math.max(ductZ - 0.25, corridorCeiling + 0.05);
  return {
    soffitZ,
    ductZ,
    pipeZ,
    sprinklerZ: pipeZ,
    trayZ: pipeZ,
    ceilingZ: corridorCeiling,
    plenumDepth: floorToFloor - corridorCeiling,
  };
}

/** A lane polyline (Vec3) parallel to a corridor centreline at lateral offset and height */
export function lanePath(centerline: Segment2[], lateral: number, z: number): Vec3[] {
  const pts: Vec3[] = [];
  for (let i = 0; i < centerline.length; i++) {
    const s = centerline[i];
    const n = perp(segDir(s));
    const a: Vec2 = add(s.a, scale(n, lateral));
    const b: Vec2 = add(s.b, scale(n, lateral));
    if (i === 0) pts.push([a[0], a[1], z]);
    pts.push([b[0], b[1], z]);
  }
  return pts;
}

/**
 * Standard mounting heights (storey-local Z, metres). Region-neutral defaults that satisfy
 * NEC/ADA and BS 7671/Part M ranges.
 */
export const MOUNTING = {
  receptacle: 0.4,
  counterReceptacle: 1.1,
  switch: 1.2,
  thermostat: 1.5,
  panelBottom: 1.2,
  wallLight: 2.0,
  ceilingLightDrop: 0.0,
  smokeAlarmDrop: 0.0,
  windowSill: 0.9,
  doorHeight: 2.1,
  unitEntryDoorHeight: 2.1,
  lavatoryRim: 0.85,
  showerValve: 1.1,
  hoseBibb: 0.5,
  sprinklerHeadDrop: 0.05,
} as const;

/** Standard element sizes (m) */
export const SIZES = {
  exteriorWallT: 0.3,
  partyWallT: 0.25,
  corridorWallT: 0.2,
  partitionT: 0.12,
  wetWallT: 0.2,
  coreWallT: 0.25,
  shaftWallT: 0.15,
  slabT: 0.2,
  doorInterior: 0.8,
  doorBathroom: 0.75,
  doorUnitEntry: 0.9,
  doorBuildingEntry: 1.8,
  doorHeight: 2.1,
  windowHeight: 1.4,
  windowSill: 0.9,
  stairWidth: 1.1,
  stairRiserMax: 0.18,
  stairTreadMin: 0.28,
  elevatorCarW: 1.6,
  elevatorCarD: 1.5,
  elevatorShaftW: 2.0,
  elevatorShaftD: 2.2,
  parkingStallW: 2.6,
  parkingStallL: 5.4,
  parkingAisleW: 6.0,
  accessibleStallW: 3.6,
} as const;
