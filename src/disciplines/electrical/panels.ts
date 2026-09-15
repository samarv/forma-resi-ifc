/**
 * Panels, service equipment and distribution:
 *   ELE-01 Service at the Street, Meters at the Entrance
 *   ELE-02 One Panel per Dwelling in the Hall   (NEC 240.24(D)/(E) exclusions)
 *   ELE-07 Corridor Tray Spine                  (XD-02 tray lane)
 *   ELE-12 Risers at the Core                   (XD-04 shafts)
 */
import type {
  ElecPanel, ElecRiser, Rect, RoomDef, RoomType, Segment2, ShaftDef, Vec2, Vec3,
} from '../../core/types.ts';
import { DEFAULT_LANES, lanePath, plenumBands } from '../../core/coordination.ts';
import { dist, rectCenter, segPointAt } from '../../core/geometry.ts';
import { SITE_STOREY } from '../../core/ids.ts';
import { PANEL_SPEC, RUN_COLORS } from './catalog.ts';
import {
  addPanel, addRun, ceilingOf, doorsOnFace, facesOf, windowsOnFace, type ElecCtx, type UnitContext,
} from './internal.ts';
import {
  anchorOnFace, bestFreeSpan, blockedSpans, closestOnPolyline, nearestFace, polylineLength,
  type RoomFace,
} from './placement.ts';

const PANEL_FORBIDDEN: Partial<Record<RoomType, boolean>> = {
  bathroom: true, ensuite: true, powder: true, wc: true, bedroom: true, 'master-bedroom': true,
  kitchen: true, 'shared-kitchen': true, closet: true, 'walk-in-closet': true, stair: true,
  shaft: true, elevator: true, balcony: true, terrace: true, porch: true, corridor: true,
};

const PANEL_PREFERENCE: RoomType[] = ['hall', 'entry', 'utility', 'laundry', 'storage', 'den', 'study', 'basement', 'garage'];

export function panelRoomAllowed(t: RoomType): boolean {
  return PANEL_FORBIDDEN[t] !== true;
}

function blockedFor(ec: ElecCtx) {
  return (f: RoomFace) => blockedSpans(f, doorsOnFace(ec, f), windowsOnFace(ec, f), ec.wallById, 2.2);
}

/** ELE-02: one panelboard per dwelling, on a hall/utility wall near the entry */
export function placeUnitPanel(ec: ElecCtx, uc: UnitContext, amps: number): ElecPanel | null {
  const spec = PANEL_SPEC['unit-panel'];
  const entry = uc.entryDoor;
  const entryWall = entry ? ec.wallById.get(entry.wallId) : undefined;
  const entryPoint: Vec2 = entry && entryWall
    ? segPointAt({ a: entryWall.start, b: entryWall.end }, entry.along)
    : rectCenter(uc.unit.rect);
  const candidates = uc.rooms
    .filter(r => panelRoomAllowed(r.type) && r.area > 1.2)
    .map(r => ({
      room: r,
      score: (PANEL_PREFERENCE.indexOf(r.type) >= 0 ? 0 : 50) + PANEL_PREFERENCE.indexOf(r.type) * 2
        + dist(rectCenter(r.rect), entryPoint),
    }))
    .sort((a, b) => a.score - b.score);
  for (const c of candidates) {
    const faces = facesOf(ec, c.room);
    const need = spec.w + 0.2;
    const hit = bestFreeSpan(faces, blockedFor(ec), need, f => (f.isExternal ? -2 : 1.5) + (f.wallId ? 0.5 : -5));
    if (!hit) continue;
    const along = (hit.span.a + hit.span.b) / 2;
    const anchor = anchorOnFace(hit.face, along, spec.bottom + spec.h / 2);
    return addPanel(ec, c.room.storey, 'unit-panel', anchor, hit.face.rotation, { w: spec.w, d: spec.d, h: spec.h }, {
      roomId: c.room.id,
      unitId: uc.unit.id,
      amps,
      voltage: ec.region.unitService,
      circuitCount: 0,
    });
  }
  ec.warnings.push(`electrical: no eligible wall for the panel of ${uc.unit.id}`);
  return null;
}

export interface ServiceRoomPick {
  room: RoomDef;
  faces: RoomFace[];
}

/** The electrical room (or the best fallback) on the lowest above-grade storey */
export function serviceRoom(ec: ElecCtx): ServiceRoomPick | null {
  const order: RoomType[] = ['elec-room', 'mech-room', 'plant', 'water-room', 'utility', 'storage', 'lobby', 'garage', 'basement'];
  const storeys = [...ec.storeys].sort((a, b) => a.index - b.index).map(s => s.id);
  for (const t of order) {
    for (const sid of storeys) {
      const room = (ec.roomsByStorey.get(sid) ?? []).find(r => r.type === t && !r.unitId);
      if (room) return { room, faces: facesOf(ec, room) };
    }
  }
  const any = ec.arch.rooms.find(r => !r.unitId && r.type !== 'shaft' && r.type !== 'elevator');
  if (any) return { room: any, faces: facesOf(ec, any) };
  // Houses have no common rooms: the intake sits in a utility space of the dwelling itself
  for (const t of order) {
    for (const sid of storeys) {
      const room = (ec.roomsByStorey.get(sid) ?? []).find(r => r.type === t);
      if (room) return { room, faces: facesOf(ec, room) };
    }
  }
  for (const sid of storeys) {
    const room = (ec.roomsByStorey.get(sid) ?? []).find(r => r.type === 'hall' || r.type === 'entry');
    if (room) return { room, faces: facesOf(ec, room) };
  }
  return null;
}

export interface ServiceEquipment {
  switchboard: ElecPanel | null;
  housePanel: ElecPanel | null;
  meters: ElecPanel[];
  transformer: boolean;
  lateralLengthM: number;
}

/** ELE-01: service lateral from the street, transformer pad, switchboard, meters, house panel */
export function placeServiceEquipment(ec: ElecCtx, serviceAmps: number, unitCount: number, houseCircuits: number): ServiceEquipment {
  const pick = serviceRoom(ec);
  const out: ServiceEquipment = { switchboard: null, housePanel: null, meters: [], transformer: false, lateralLengthM: 0 };
  if (!pick) {
    ec.warnings.push('electrical: no room found for the service equipment');
    return out;
  }
  const { room, faces } = pick;
  const used = new Map<string, number>();
  const sorted = [...faces].sort((a, b) => b.length - a.length);
  // A single dwelling takes its supply through its own consumer unit / load centre: one meter,
  // no switchboard and no house panel (NEC 230.71 / BS 7671 §8.2 intake position).
  const single = unitCount <= 1;

  // Main switchboard: free-standing against the longest wall
  const msb = PANEL_SPEC['main-switchboard'];
  const msbFace = single ? undefined : sorted.find(f => f.length >= msb.w + 0.3) ?? sorted[0];
  if (msbFace) {
    const along = Math.min(msbFace.length - msb.w / 2 - 0.1, msb.w / 2 + 0.15);
    const p = segPointAt(msbFace.seg, Math.max(msb.w / 2, along));
    const anchor: Vec3 = [
      p[0] + msbFace.inward[0] * (0.1 + msb.d / 2),
      p[1] + msbFace.inward[1] * (0.1 + msb.d / 2),
      0,
    ];
    out.switchboard = addPanel(ec, room.storey, 'main-switchboard', anchor, msbFace.rotation, { w: msb.w, d: msb.d, h: msb.h }, {
      roomId: room.id, amps: serviceAmps, voltage: ec.region.service, circuitCount: unitCount + houseCircuits,
    });
    used.set(msbFace.wallId + ':' + msbFace.length, msb.w + 0.5);
  }

  // Meter bank(s): one meter per dwelling in stacks of 6. When the switchroom cannot take them
  // all, the overflow continues along the adjacent corridor wall (metering must stay accessible).
  const mtr = PANEL_SPEC['meter-bank'];
  const bankCount = unitCount > 0 ? Math.ceil(unitCount / 6) : 0;
  let placedBanks = 0;
  const overflowRooms = (ec.roomsByStorey.get(room.storey) ?? [])
    .filter(r => r.id !== room.id && (r.type === 'corridor' || r.type === 'lobby' || r.type === 'lift-lobby' || r.type === 'mail'));
  const candidateFaces: { face: RoomFace; roomId: string }[] = [
    ...sorted.map(f => ({ face: f, roomId: room.id })),
  ];
  for (const overflow of overflowRooms) {
    for (const f of facesOf(ec, overflow).sort((a, b) => b.length - a.length)) {
      candidateFaces.push({ face: f, roomId: overflow.id });
    }
  }
  for (const candidate of candidateFaces) {
    if (placedBanks >= bankCount) break;
    const face = candidate.face;
    let cursor = (used.get(face.wallId + ':' + face.length) ?? 0) + 0.2;
    const blocked = blockedFor(ec)(face);
    while (placedBanks < bankCount && cursor + mtr.w <= face.length - 0.1) {
      const mid = cursor + mtr.w / 2;
      if (blocked.some(b => mid > b.a - mtr.w / 2 && mid < b.b + mtr.w / 2)) {
        cursor += 0.3;
        continue;
      }
      const anchor = anchorOnFace(face, mid, mtr.bottom + mtr.h / 2);
      out.meters.push(addPanel(ec, room.storey, 'meter-bank', anchor, face.rotation, { w: mtr.w, d: mtr.d, h: mtr.h }, {
        roomId: candidate.roomId,
        amps: 100 * Math.min(6, unitCount - placedBanks * 6),
        voltage: ec.region.service,
        circuitCount: Math.min(6, unitCount - placedBanks * 6),
      }));
      cursor += mtr.w + 0.1;
      placedBanks++;
    }
  }
  if (placedBanks < bankCount) {
    ec.warnings.push(`electrical: only ${placedBanks} of ${bankCount} meter banks fit near ${room.id} — a dedicated meter room of ${(bankCount * 1.3).toFixed(1)} m of wall is needed`);
  }

  // House panel
  const hp = PANEL_SPEC['house-panel'];
  const hpHit = single ? null : bestFreeSpan(faces, blockedFor(ec), hp.w + 0.2, f => (f.isExternal ? -1 : 1));
  if (hpHit) {
    const anchor = anchorOnFace(hpHit.face, (hpHit.span.a + hpHit.span.b) / 2, hp.bottom + hp.h / 2);
    out.housePanel = addPanel(ec, room.storey, 'house-panel', anchor, hpHit.face.rotation, { w: hp.w, d: hp.d, h: hp.h }, {
      roomId: room.id, amps: 225, voltage: ec.region.service, circuitCount: houseCircuits,
    });
  }

  // Buried service lateral from the street edge (y = 0) to the service room
  const target: Vec2 = out.switchboard
    ? [out.switchboard.position[0], out.switchboard.position[1]]
    : rectCenter(room.rect);
  // street edge → pull pit in the front yard → switchroom
  const bend: Vec3 = [target[0], Math.max(0.5, target[1] / 2), -0.8];
  const end: Vec3 = [target[0], target[1], -0.8];
  const r1 = addRun(ec, 'lateral', SITE_STOREY, [target[0], 0, -0.8], bend, {
    name: 'Service lateral (from the street)',
    profile: { type: 'circle', radius: 0.05 },
    ifcType: 'IfcCableCarrierSegment',
    predefinedType: 'CONDUITSEGMENT',
    objectType: 'Service lateral duct',
    color: RUN_COLORS.conduit,
    system: 'POWER-LV',
    note: 'ELE-01 buried service lateral, 800 mm cover',
    patterns: ['ELE-01'],
  });
  const r2 = addRun(ec, 'lateral', SITE_STOREY, bend, end, {
    name: 'Service lateral (to the switchroom)',
    profile: { type: 'circle', radius: 0.05 },
    ifcType: 'IfcCableCarrierSegment',
    predefinedType: 'CONDUITSEGMENT',
    objectType: 'Service lateral duct',
    color: RUN_COLORS.conduit,
    system: 'POWER-LV',
    note: 'ELE-01 buried service lateral, 800 mm cover',
    patterns: ['ELE-01'],
  });
  out.lateralLengthM = r1.lengthM + r2.lengthM;

  // Pad-mounted transformer near the front boundary for services over 600 A
  if (serviceAmps > 600) {
    const site = ec.ctx.site;
    const bounds = site.boundary.length > 0 ? site.boundary : [[0, 0] as Vec2];
    let maxX = 0;
    for (const p of bounds) maxX = Math.max(maxX, p[0]);
    const x = Math.min(Math.max(3.0, target[0] - 12), Math.max(3.0, maxX - 3.0));
    ec.devices.push({
      id: ec.ids.next(SITE_STOREY, 'XFMR'),
      storey: SITE_STOREY,
      type: 'transformer',
      position: [x, 3.0, 0],
      rotation: 0,
      watts: 0,
    });
    ec.extra.set(ec.devices[ec.devices.length - 1].id, {
      va: 0, lumens: 0, want: null, name: 'Pad-mounted transformer',
      note: `ELE-01 utility transformer pad for a ${serviceAmps} A service`,
    });
    out.transformer = true;
  }
  return out;
}

/** A distribution board per storey in the electrical shaft / corridor wall (buildings ≥ 4 storeys) */
export function placeFloorDistribution(ec: ElecCtx): ElecPanel[] {
  const out: ElecPanel[] = [];
  if (ec.storeys.length < 4) return out;
  const spec = PANEL_SPEC['floor-distribution'];
  const shafts = elecShafts(ec);
  for (const st of ec.storeys) {
    const rooms = ec.roomsByStorey.get(st.id) ?? [];
    const corridor = rooms.find(r => r.type === 'corridor')
      ?? rooms.find(r => r.type === 'lift-lobby' || r.type === 'lobby');
    if (!corridor) continue;
    const faces = facesOf(ec, corridor);
    const shaft = shafts.find(s => s.storeys.includes(st.id)) ?? shafts[0];
    const ref: Vec2 = shaft ? rectCenter(shaft.rect) : rectCenter(corridor.rect);
    let hit = nearestFace(faces, ref, spec.w + 0.2);
    if (!hit) {
      const span = bestFreeSpan(faces, blockedFor(ec), spec.w + 0.2);
      hit = span ? { face: span.face, along: (span.span.a + span.span.b) / 2 } : null;
    }
    if (!hit) continue;
    const blocked = blockedFor(ec)(hit.face);
    let along = hit.along;
    for (const b of blocked) {
      if (along > b.a - spec.w / 2 && along < b.b + spec.w / 2) along = b.b + spec.w / 2 + 0.1;
    }
    along = Math.max(spec.w / 2 + 0.1, Math.min(hit.face.length - spec.w / 2 - 0.1, along));
    if (hit.face.length < spec.w + 0.3) continue;
    out.push(addPanel(ec, st.id, 'floor-distribution', anchorOnFace(hit.face, along, spec.bottom + spec.h / 2), hit.face.rotation, { w: spec.w, d: spec.d, h: spec.h }, {
      roomId: corridor.id, amps: 225, voltage: ec.region.service, circuitCount: 12,
    }));
  }
  return out;
}

export function elecShafts(ec: ElecCtx): ShaftDef[] {
  return ec.arch.shafts.filter(s => s.purpose === 'electrical' || s.purpose === 'combined');
}

// ----------------------------------------------------------------------------
// ELE-07 corridor tray spine
// ----------------------------------------------------------------------------

export interface TrayResult {
  trayLengthM: number;
  /** storey → power tray path, used to drop feeders into dwellings */
  laneByStorey: Map<string, Vec3[]>;
}

export function buildTrays(ec: ElecCtx): TrayResult {
  const laneByStorey = new Map<string, Vec3[]>();
  let trayLengthM = 0;
  const slabT = ec.ctx.struct?.sizes.slabT ?? 0.2;
  for (const st of ec.storeys) {
    const fp = ec.floorByStorey.get(st.id);
    const rooms = ec.roomsByStorey.get(st.id) ?? [];
    const defs = fp?.corridors ?? [];
    const lines: { segs: Segment2[]; room: RoomDef | null }[] = [];
    for (const d of defs) {
      const room = ec.roomById.get(d.roomId) ?? null;
      if (d.centerline.length > 0) lines.push({ segs: d.centerline, room });
      else if (room) lines.push({ segs: rectSpine(room.rect), room });
    }
    if (lines.length === 0) {
      for (const r of rooms.filter(x => x.type === 'corridor')) lines.push({ segs: rectSpine(r.rect), room: r });
    }
    if (lines.length === 0) continue;
    const ceiling = lines[0].room ? ceilingOf(ec, lines[0].room) : Math.max(2.3, st.height - 0.45);
    const beamDepth = beamDepthFor(ec, st.height, slabT, ceiling);
    const bands = plenumBands(st.height, slabT, beamDepth, ceiling);
    for (const line of lines) {
      const power = lanePath(line.segs, DEFAULT_LANES.tray, bands.trayZ);
      const data = lanePath(line.segs, DEFAULT_LANES.tray + 0.15, bands.trayZ);
      const powerId = ec.ids.next(st.id, 'TRAYRUN');
      ec.trays.push({ id: powerId, storey: st.id, path: power, width: 0.3, height: 0.1, purpose: 'power' });
      ec.trays.push({ id: ec.ids.next(st.id, 'TRAYRUN'), storey: st.id, path: data, width: 0.2, height: 0.05, purpose: 'data' });
      trayLengthM += polylineLength(power) + polylineLength(data);
      for (let i = 1; i < power.length; i++) {
        addRun(ec, 'tray', st.id, power[i - 1], power[i], {
          name: 'Power cable tray 300 × 100',
          profile: { type: 'rect', width: 0.3, height: 0.1 },
          ifcType: 'IfcCableCarrierSegment',
          predefinedType: 'CABLETRAYSEGMENT',
          color: RUN_COLORS.tray,
          system: 'POWER-LV',
          roomId: line.room?.id,
          note: `XD-02 tray lane +${DEFAULT_LANES.tray} m from the corridor centreline at z ${round2(bands.trayZ)}`,
          patterns: ['ELE-07', 'XD-02'],
        });
      }
      for (let i = 1; i < data.length; i++) {
        addRun(ec, 'data-tray', st.id, data[i - 1], data[i], {
          name: 'Data cable tray 200 × 50',
          profile: { type: 'rect', width: 0.2, height: 0.05 },
          ifcType: 'IfcCableCarrierSegment',
          predefinedType: 'CABLETRAYSEGMENT',
          color: RUN_COLORS.dataTray,
          system: 'DATA',
          roomId: line.room?.id,
          note: `XD-02 data tray 150 mm outboard of the power tray at z ${round2(bands.trayZ)}`,
          patterns: ['ELE-07', 'XD-02'],
        });
      }
      if (!laneByStorey.has(st.id)) laneByStorey.set(st.id, power);
    }
  }
  return { trayLengthM, laneByStorey };
}

function rectSpine(r: Rect): Segment2[] {
  return r.w >= r.h
    ? [{ a: [r.x, r.y + r.h / 2], b: [r.x + r.w, r.y + r.h / 2] }]
    : [{ a: [r.x + r.w / 2, r.y], b: [r.x + r.w / 2, r.y + r.h] }];
}

function beamDepthFor(ec: ElecCtx, f2f: number, slabT: number, ceiling: number): number {
  const soffit = ec.ctx.struct?.plenumClearance?.corridorSoffitZ;
  if (typeof soffit === 'number' && soffit > 0) return Math.max(0, f2f - slabT - soffit);
  return ec.ctx.struct?.sizes.beamD ?? 0;
}

// ----------------------------------------------------------------------------
// ELE-12 risers at the core
// ----------------------------------------------------------------------------

export function buildRisers(ec: ElecCtx): { risers: ElecRiser[]; lengthM: number } {
  const shafts = elecShafts(ec);
  const out: ElecRiser[] = [];
  let lengthM = 0;
  const storeyCount = ec.storeys.length;
  const type: ElecRiser['type'] = storeyCount > 6 ? 'busduct' : 'cable-riser';
  const w = 0.3;
  const d = 0.2;
  for (const shaft of shafts) {
    // convention: mechanical takes the shaft centre, plumbing the min corner, electrical the max corner
    const xy: Vec2 = [shaft.rect.x + shaft.rect.w - 0.15, shaft.rect.y + shaft.rect.h - 0.15];
    const storeys = ec.storeys.filter(s => shaft.storeys.length === 0 || shaft.storeys.includes(s.id));
    if (storeys.length === 0) continue;
    const riser: ElecRiser = {
      id: ec.ids.next(storeys[0].id, 'RISER'),
      shaftId: shaft.id,
      type,
      fromStorey: storeys[0].id,
      toStorey: storeys[storeys.length - 1].id,
      xy,
      width: w,
      depth: d,
    };
    out.push(riser);
    for (const st of storeys) {
      const run = addRun(ec, 'busduct', st.id, [xy[0], xy[1], 0], [xy[0], xy[1], st.height], {
        name: type === 'busduct' ? 'Busduct riser 300 × 200' : 'Cable riser 300 × 200',
        profile: { type: 'rect', width: w, height: d },
        ifcType: 'IfcCableCarrierSegment',
        predefinedType: 'CABLETRAYSEGMENT',
        objectType: type === 'busduct' ? 'Busduct' : 'Cable riser',
        color: RUN_COLORS.busduct,
        system: 'POWER-LV',
        note: `ELE-12/XD-04 riser in shaft ${shaft.id} at the max corner − 0.15 m`,
        patterns: ['ELE-12', 'XD-04'],
      });
      lengthM += run.lengthM;
    }
  }
  ec.risers.push(...out);
  return { risers: out, lengthM };
}

// ----------------------------------------------------------------------------
// Feeders: tray lane → dwelling panel
// ----------------------------------------------------------------------------

export function buildFeeders(ec: ElecCtx, lanes: Map<string, Vec3[]>, panels: ElecPanel[]): number {
  if (ec.detail === 'low') return 0;
  let length = 0;
  for (const panel of panels) {
    if (panel.type !== 'unit-panel') continue;
    const lane = lanes.get(panel.storey);
    if (!lane || lane.length < 2) continue;
    const unit = panel.unitId ? ec.unitById.get(panel.unitId) : undefined;
    const entry = unit ? ec.doorById.get(unit.entryDoorId) : undefined;
    const wall = entry ? ec.wallById.get(entry.wallId) : undefined;
    const ref: Vec2 = wall && entry
      ? segPointAt({ a: wall.start, b: wall.end }, entry.along)
      : [panel.position[0], panel.position[1]];
    const a = closestOnPolyline(lane, ref);
    const spec = PANEL_SPEC['unit-panel'];
    const top = spec.bottom + spec.h;
    const b: Vec3 = [panel.position[0], panel.position[1], a[2]];
    const c: Vec3 = [panel.position[0], panel.position[1], top];
    const common = {
      name: 'Feeder conduit Ø32',
      profile: { type: 'circle' as const, radius: 0.016 },
      ifcType: 'IfcCableCarrierSegment',
      predefinedType: 'CONDUITSEGMENT',
      color: RUN_COLORS.conduit,
      system: 'POWER-LV' as const,
      unitId: panel.unitId,
      roomId: panel.roomId,
      note: 'Feeder from the corridor tray, above the dwelling entry door, down to the panel',
      patterns: ['ELE-07', 'XD-02'],
    };
    length += addRun(ec, 'conduit', panel.storey, a, b, common).lengthM;
    length += addRun(ec, 'conduit', panel.storey, b, c, common).lengthM;
  }
  ec.conduitLengthM += length;
  return length;
}

// ----------------------------------------------------------------------------
// EV and PV support equipment
// ----------------------------------------------------------------------------

export function placeEvPanel(ec: ElecCtx, chargerCount: number, near: Vec2 | null, storey: string): ElecPanel | null {
  if (chargerCount === 0) return null;
  const spec = PANEL_SPEC['ev-panel'];
  const amps = Math.max(100, Math.ceil((chargerCount * 40 * 0.5) / 50) * 50);
  const parking = ec.arch.rooms.find(r => r.type === 'parking' || r.type === 'garage');
  if (parking) {
    const hit = bestFreeSpan(facesOf(ec, parking), blockedFor(ec), spec.w + 0.2);
    if (hit) {
      return addPanel(ec, parking.storey, 'ev-panel', anchorOnFace(hit.face, (hit.span.a + hit.span.b) / 2, spec.bottom + spec.h / 2), hit.face.rotation, { w: spec.w, d: spec.d, h: spec.h }, {
        roomId: parking.id, amps, voltage: ec.region.service, circuitCount: chargerCount,
      });
    }
  }
  const at: Vec2 = near ?? [0, 0];
  return addPanel(ec, storey, 'ev-panel', [at[0], at[1], 0], 0, { w: spec.w, d: spec.d, h: spec.h }, {
    amps, voltage: ec.region.service, circuitCount: chargerCount,
  });
}

export function placePvEquipment(ec: ElecCtx, kwDc: number, zone: Rect | null): { combiner: ElecPanel | null; inverter: boolean } {
  if (kwDc <= 0 || !zone) return { combiner: null, inverter: false };
  const plant = ec.arch.roof.plantZone ?? zone;
  const spec = PANEL_SPEC['pv-combiner'];
  const anchor: Vec3 = [plant.x + plant.w + 0.6, plant.y + 0.6, spec.bottom + spec.h / 2];
  const combiner = addPanel(ec, 'ROOF', 'pv-combiner', anchor, 0, { w: spec.w, d: spec.d, h: spec.h }, {
    amps: Math.max(60, Math.ceil((kwDc * 1000) / ec.region.serviceV / 10) * 10),
    voltage: `${Math.round(kwDc * 10) / 10} kWdc`,
    circuitCount: Math.max(1, Math.ceil(kwDc / 6)),
  });
  const inv: Vec3 = [plant.x + plant.w + 0.6, plant.y + 1.8, 0];
  const d = ec.devices.length;
  ec.devices.push({ id: ec.ids.next('ROOF', 'INV'), storey: 'ROOF', type: 'inverter', position: inv, rotation: 0, watts: 0 });
  ec.extra.set(ec.devices[d].id, {
    va: 0, lumens: 0, want: 'pv', name: `PV inverter ${Math.round(kwDc * 10) / 10} kW`,
    note: 'ELE-09 string inverter beside the plant zone',
  });
  return { combiner, inverter: true };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
