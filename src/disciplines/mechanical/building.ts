/**
 * Building-wide mechanical systems: the corridor make-up air spine (MEC-05), roof plant
 * (MEC-06), stair pressurisation (MEC-07) and the central water-side plant of a
 * central-AHU / fan-coil or heat-network building.
 */
import type { MechEquipment, Rect, ShaftDef, Vec2, Vec3 } from '../../core/types.ts';
import { dist, inset, polygonArea, rectCenter } from '../../core/geometry.ts';
import { DEFAULT_LANES, lanePath } from '../../core/coordination.ts';
import type { MechBuild, StoreyInfo } from './context.ts';
import { CORRIDOR_MAKEUP_LS_PER_M2, r1, rectTrunkWidth } from './loads.ts';
import { boxAtCentre, closestOnPath, joinPath, pathLength, routeOrthogonal, samplePath, nearestShaft } from './placement.ts';

export interface BuildingTotals {
  coolingKw: number;
  heatingKw: number;
  ventilationLs: number;
}

export interface BuildingResult {
  corridorLs: number;
  rooftopUnits: number;
  pressurisedStairs: number;
  plantItems: number;
}

export function generateBuildingSystems(b: MechBuild, totals: BuildingTotals): BuildingResult {
  const res: BuildingResult = { corridorLs: 0, rooftopUnits: 0, pressurisedStairs: 0, plantItems: 0 };
  const corridorResult = corridorSpine(b);
  res.corridorLs = corridorResult.airflowLs;
  res.rooftopUnits = corridorResult.rtus;
  res.plantItems += corridorResult.rtus;
  res.pressurisedStairs = stairPressurisation(b);
  res.plantItems += centralPlant(b, totals);
  res.plantItems += vrfCondensers(b, totals);
  return res;
}

// ----------------------------------------------------------------------------
// Corridor make-up air spine (MEC-05 / XD-02)
// ----------------------------------------------------------------------------

function corridorSpine(b: MechBuild): { airflowLs: number; rtus: number } {
  let airflowLs = 0;
  const feedShafts = new Map<string, { shaft: ShaftDef; airflowLs: number }>();
  const spacing = b.detail === 'low' ? 12 : 9;

  for (const st of b.resiStoreys) {
    for (const corridor of st.corridors) {
      if (corridor.centerline.length === 0) continue;
      const area = corridor.polygon.length >= 3
        ? polygonArea(corridor.polygon)
        : corridor.centerline.reduce((s, c) => s + dist(c.a, c.b), 0) * corridor.width;
      const q = Math.max(30, area * CORRIDOR_MAKEUP_LS_PER_M2);
      const depth = st.corridorDuctDepth;
      const width = Math.max(0.5, rectTrunkWidth(q, depth));
      const path = lanePath(corridor.centerline, DEFAULT_LANES.duct, st.corridorDuctZ);
      if (path.length < 2) continue;
      const run = b.addDuct({
        storey: st.id,
        systemType: 'supply',
        path,
        shape: 'rect',
        width,
        height: depth,
        servesRoomIds: [corridor.roomId],
        airflowLs: q,
        name: 'Corridor make-up air',
        patterns: ['MEC-05', 'XD-02'],
        tags: ['corridor-spine'],
      });
      airflowLs += q;

      const points = samplePath(path, spacing);
      for (const p of points) {
        b.addTerminal({
          storey: st.id,
          type: 'supply-diffuser',
          roomId: corridor.roomId,
          xy: [p[0], p[1]],
          z: st.ceilingHeight,
          width: 0.3,
          depth: 0.3,
          airflowLs: q / Math.max(1, points.length),
          patterns: ['MEC-05'],
          name: 'Corridor supply diffuser',
        });
      }

      // Feed from a riser in the shaft nearest the core
      const shaft = shaftNearCore(b, st.id, [path[0][0], path[0][1]]);
      if (shaft) {
        const prev = feedShafts.get(shaft.id);
        feedShafts.set(shaft.id, { shaft, airflowLs: (prev?.airflowLs ?? 0) + q });
        const riser = b.ensureRiser(`${shaft.id}:supply`, () => ({
          shaftId: shaft.id,
          systemType: 'supply',
          fromStorey: b.lowestResidentialStoreyId(),
          toStorey: b.roofStoreyId(),
          xy: b.claimShaftXY(shaft, true),
          width: Math.max(0.4, width),
          height: Math.max(0.3, depth),
          shape: 'rect',
          patterns: ['MEC-05', 'XD-04'],
          serves: 'corridor make-up air',
        }));
        const tap = closestOnPath(path, riser.xy);
        b.addDuct({
          storey: st.id,
          systemType: 'supply',
          path: joinPath([[riser.xy[0], riser.xy[1], st.corridorDuctZ]], routeOrthogonal(riser.xy, [tap[0], tap[1]], st.corridorDuctZ)),
          shape: 'rect',
          width: Math.max(0.4, width),
          height: depth,
          servesRoomIds: [corridor.roomId],
          airflowLs: q,
          name: 'Corridor riser tap',
          patterns: ['MEC-05', 'XD-02'],
        });
      }

      b.apply('MEC-05', {
        storey: st.id,
        params: {
          corridorAreaM2: r1(area),
          airflowLs: r1(q),
          duct: `${Math.round(width * 1000)} × ${Math.round(depth * 1000)} mm`,
          ductZ: st.corridorDuctZ,
          diffusers: points.length,
          spacingM: spacing,
          runLengthM: r1(run ? pathLength(run.path) : 0),
        },
      });
    }
  }

  // One rooftop unit per feeding shaft (MEC-06)
  let rtus = 0;
  for (const { shaft, airflowLs: q } of feedShafts.values()) {
    placeOnRoof(b, 'rtu', { w: 2.4, d: 1.2, h: 1.4 }, {
      name: `Rooftop unit — corridor make-up air (${shaft.id})`,
      patterns: ['MEC-05', 'MEC-06'],
      airflowLs: q,
      serves: shaft.id,
    });
    rtus++;
  }
  return { airflowLs, rtus };
}

function shaftNearCore(b: MechBuild, storeyId: string, fallback: Vec2): ShaftDef | null {
  const cores = b.ctx.arch?.cores ?? [];
  if (cores.length > 0 && b.shafts.length > 0) {
    let best: ShaftDef | null = null;
    let bestD = Infinity;
    for (const core of cores) {
      for (const s of b.shafts) {
        const d = dist(rectCenter(core.rect), rectCenter(s.rect));
        if (d < bestD) { bestD = d; best = s; }
      }
    }
    if (best) return best;
  }
  return nearestShaft(b.shafts, fallback, storeyId);
}

// ----------------------------------------------------------------------------
// Roof plant (MEC-06)
// ----------------------------------------------------------------------------

export interface RoofPlantOpts {
  name: string;
  patterns: string[];
  capacityKw?: number;
  airflowLs?: number;
  serves?: string;
  ifc?: { objectType?: string; predefinedType?: string; ifcType?: string };
}

export function placeOnRoof(b: MechBuild, type: MechEquipment['type'], size: { w: number; d: number; h: number }, o: RoofPlantOpts): MechEquipment {
  const min = b.roofGrid.place(size.w, size.d);
  return b.addEquipment({
    storey: b.roofStoreyId(),
    type,
    position: [min[0], min[1], 0.1],
    width: size.w,
    depth: size.d,
    height: size.h,
    name: o.name,
    capacityKw: o.capacityKw,
    airflowLs: o.airflowLs,
    serves: o.serves,
    patterns: [...o.patterns, 'MEC-06'],
    tags: ['roof-plant'],
    ifc: o.ifc,
  });
}

// ----------------------------------------------------------------------------
// Stair pressurisation (MEC-07)
// ----------------------------------------------------------------------------

function stairPressurisation(b: MechBuild): number {
  // IBC §403/§909.20 and ADB measure the trigger to the HIGHEST OCCUPIED FLOOR level.
  const top = b.resiStoreys.length > 0 ? Math.max(...b.resiStoreys.map(s => s.elevation)) : 0;
  const trigger = 23;
  if (top <= trigger) return 0;
  const cores = (b.ctx.arch?.cores ?? []).filter(c => c.type !== 'point-core' || c.stairIds.length > 0);
  if (cores.length === 0) return 0;
  for (const core of cores) {
    const box = boxAtCentre(rectCenter(core.rect), 1.2, 1.2, 0.1);
    b.addEquipment({
      storey: b.roofStoreyId(),
      type: 'exhaust-fan',
      position: box.position,
      width: 1.2,
      depth: 1.2,
      height: 1.0,
      name: `Stair pressurisation fan — ${core.id}`,
      patterns: ['MEC-07'],
      serves: core.id,
      tags: ['stair-pressurisation'],
      ifc: { objectType: 'Stair pressurisation fan' },
    });
    // The supply duct drops down a corner of the stair enclosure (shaftId = the core id here)
    const safe = inset(core.rect, 0.35);
    b.ensureRiser(`${core.id}:pressurisation`, () => ({
      shaftId: core.id,
      systemType: 'corridor-pressurization',
      fromStorey: b.lowestResidentialStoreyId(),
      toStorey: b.roofStoreyId(),
      xy: [safe.x, safe.y],
      width: 0.6,
      height: 0.4,
      shape: 'rect',
      label: 'PRESS',
      patterns: ['MEC-07'],
      serves: core.id,
    }));
  }
  b.apply('MEC-07', {
    storey: b.roofStoreyId(),
    params: { highestOccupiedFloorM: r1(top), triggerM: trigger, fans: cores.length, pressurePa: 50 },
  });
  return 1;
}

// ----------------------------------------------------------------------------
// Central water-side plant
// ----------------------------------------------------------------------------

function centralPlant(b: MechBuild, totals: BuildingTotals): number {
  if (b.units.length === 0) return 0;
  const needsChiller = b.hvac === 'central-ahu-fan-coil';
  const needsBoiler = b.hvac === 'central-ahu-fan-coil' || b.hvac === 'mvhr-radiators';
  if (!needsChiller && !needsBoiler) return 0;

  const mechRooms = (b.ctx.arch?.rooms ?? []).filter(r => r.type === 'mech-room' || r.type === 'plant');
  let count = 0;

  if (needsChiller) {
    const n = Math.min(4, Math.max(1, Math.ceil(totals.coolingKw / 350)));
    for (let i = 0; i < n; i++) {
      placeOnRoof(b, 'chiller', { w: 2.4, d: 1.6, h: 2.0 }, {
        name: `Air-cooled chiller ${i + 1}`,
        patterns: ['MEC-01'],
        capacityKw: totals.coolingKw / n,
        serves: 'chilled water',
      });
      count++;
    }
    placeOnRoof(b, 'ahu', { w: 3.0, d: 1.8, h: 1.8 }, {
      name: 'Central air handling unit',
      patterns: ['MEC-01'],
      airflowLs: totals.ventilationLs,
      serves: 'dwelling outdoor air',
    });
    count++;
  }

  if (needsBoiler) {
    const n = Math.min(3, Math.max(1, Math.ceil(totals.heatingKw / 300)));
    for (let i = 0; i < n; i++) {
      const room = mechRooms[i % Math.max(1, mechRooms.length)];
      if (room) {
        const box = boxAtCentre(rectCenter(room.rect), 1.2, 0.8, 0.1, 0);
        const pos: Vec3 = [box.position[0] + i * 1.4, box.position[1], 0.1];
        b.addEquipment({
          storey: room.storey,
          type: 'boiler',
          roomId: room.id,
          position: pos,
          width: 1.2,
          depth: 0.8,
          height: 1.6,
          capacityKw: totals.heatingKw / n,
          name: `Boiler ${i + 1}`,
          patterns: ['MEC-01', 'MEC-06'],
          serves: 'heating water',
          tags: ['plant-room'],
        });
      } else {
        placeOnRoof(b, 'boiler', { w: 1.2, d: 0.8, h: 1.6 }, {
          name: `Boiler ${i + 1}`,
          patterns: ['MEC-01'],
          capacityKw: totals.heatingKw / n,
          serves: 'heating water',
        });
      }
      count++;
    }
  }
  b.apply('MEC-06', {
    storey: b.roofStoreyId(),
    params: {
      plantAreaM2: r1(b.plantZone.w * b.plantZone.h),
      areaPerUnitM2: r1((b.plantZone.w * b.plantZone.h) / Math.max(1, b.units.length)),
      items: count,
      indoorPlantRooms: mechRooms.length,
    },
  });
  return count;
}

function vrfCondensers(b: MechBuild, totals: BuildingTotals): number {
  if (b.hvac !== 'vrf') return 0;
  const n = Math.max(1, Math.ceil(b.units.length / 8));
  for (let i = 0; i < n; i++) {
    placeOnRoof(b, 'vrf-condenser', { w: 1.2, d: 0.8, h: 1.6 }, {
      name: `VRF condenser ${i + 1}`,
      patterns: ['MEC-04'],
      capacityKw: totals.coolingKw / n,
      serves: `${Math.min(8, b.units.length)} dwellings`,
      ifc: { objectType: 'VRF condenser' },
    });
  }
  b.apply('MEC-06', {
    storey: b.roofStoreyId(),
    params: {
      condensers: n,
      dwellingsPerCondenser: 8,
      plantAreaM2: r1(b.plantZone.w * b.plantZone.h),
      areaPerUnitM2: r1((b.plantZone.w * b.plantZone.h) / Math.max(1, b.units.length)),
    },
  });
  return n;
}

export function plantZoneOf(b: MechBuild): Rect { return b.plantZone; }
export type { StoreyInfo };
