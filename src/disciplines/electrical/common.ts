/**
 * Common-area, life-safety-egress, site and equipment-connection devices:
 *   ELE-07 corridor lighting on the service spine
 *   ELE-08 Emergency Light the Way Out  (IBC §1008/§1013, BS 5266, NFPA 101)
 *   ELE-01 exterior lighting at entrances, bollards and poles on the site
 *   mechanical / plumbing equipment disconnects and thermostats
 */
import type { CorridorDef, DoorDef, RoomDef, Segment2, Vec2, Vec3 } from '../../core/types.ts';
import { MOUNTING } from '../../core/coordination.ts';
import { dist, rectUnionBounds, segLength, segPointAt, sideNormal } from '../../core/geometry.ts';
import { SITE_STOREY } from '../../core/ids.ts';
import { addDevice, ceilingOf, facesOf, type ElecCtx } from './internal.ts';
import {
  alongLongAxis, alongPolyline, anchorOnFace, nearestFace, rotationForInward, runPositions,
} from './placement.ts';

const EXIT_SIGN_Z = 2.3;

/** Corridor lighting, emergency lighting and corridor smoke detection for one storey */
export function generateCorridorDevices(ec: ElecCtx, storey: string): { corridorLength: number; fixtures: string[] } {
  const rooms = ec.roomsByStorey.get(storey) ?? [];
  const corridorRooms = rooms.filter(r => r.type === 'corridor');
  const defs = ec.floorByStorey.get(storey)?.corridors ?? [];
  const fixtures: string[] = [];
  let total = 0;
  const handled = new Set<string>();
  for (const def of defs) {
    const room = ec.roomById.get(def.roomId) ?? corridorRooms.find(r => r.id === def.roomId);
    const segs = def.centerline.length > 0 ? def.centerline : room ? rectCenterline(room) : [];
    if (segs.length === 0) continue;
    if (room) handled.add(room.id);
    total += lightCorridor(ec, storey, segs, room ?? null, fixtures);
  }
  for (const room of corridorRooms) {
    if (handled.has(room.id)) continue;
    total += lightCorridor(ec, storey, rectCenterline(room), room, fixtures);
  }
  return { corridorLength: total, fixtures };
}

function rectCenterline(room: RoomDef): Segment2[] {
  const r = room.rect;
  return r.w >= r.h
    ? [{ a: [r.x, r.y + r.h / 2], b: [r.x + r.w, r.y + r.h / 2] }]
    : [{ a: [r.x + r.w / 2, r.y], b: [r.x + r.w / 2, r.y + r.h] }];
}

function lightCorridor(ec: ElecCtx, storey: string, segs: Segment2[], room: RoomDef | null, fixtures: string[]): number {
  const length = segs.reduce((a, s) => a + segLength(s), 0);
  if (length < 0.5) return 0;
  const z = room ? ceilingOf(ec, room) : 2.6;
  const spacing = ec.detail === 'low' ? 9 : 4.5;
  for (const hit of alongPolyline(segs, spacing, 1)) {
    const d = addDevice(ec, storey, 'light-recessed', [hit.p[0], hit.p[1], z], 0, {
      roomId: room?.id, want: 'house-lighting', group: `${storey}:corridor-lighting`,
      note: 'ELE-07 corridor luminaires at 4.5 m centres, 100 lx maintained',
    });
    fixtures.push(d.id);
  }
  for (const hit of alongPolyline(segs, 15, 1)) {
    addDevice(ec, storey, 'light-emergency', [hit.p[0], hit.p[1], z], 0, {
      roomId: room?.id, want: 'life-safety',
      note: 'ELE-08 emergency luminaire at 15 m centres, 1 lx on the centreline for 90 min',
    });
    addDevice(ec, storey, 'smoke-alarm', [hit.p[0] + 0.2, hit.p[1], z], 0, {
      roomId: room?.id, want: 'life-safety',
      note: 'NFPA 72 corridor smoke detection at 15 m centres',
    });
  }
  return length;
}

function isStairRoom(ec: ElecCtx, id?: string): boolean {
  if (!id) return false;
  const r = ec.roomById.get(id);
  return !!r && r.type === 'stair';
}

/** Doors that must be signed and lit: exit doors, stair doors and the exit discharge */
export function egressDoors(ec: ElecCtx): DoorDef[] {
  return ec.arch.doors.filter(d =>
    d.type === 'exit' || d.type === 'building-entry' || isStairRoom(ec, d.fromRoomId) || isStairRoom(ec, d.toRoomId));
}

/** The room on the egress (signed) side of a door */
function egressSideRoom(ec: ElecCtx, door: DoorDef): RoomDef | null {
  const from = door.fromRoomId ? ec.roomById.get(door.fromRoomId) ?? null : null;
  const to = door.toRoomId ? ec.roomById.get(door.toRoomId) ?? null : null;
  const pref = [from, to].filter((r): r is RoomDef => !!r && r.type !== 'stair');
  if (pref.length > 0) {
    const circ = pref.find(r => r.type === 'corridor' || r.type === 'lobby' || r.type === 'lift-lobby');
    return circ ?? pref[0];
  }
  return from ?? to;
}

/** ELE-08: an exit sign over every exit / stair door and an emergency light beside it */
export function generateEgressDevices(ec: ElecCtx): { signs: number; emergency: number } {
  let signs = 0;
  let emergency = 0;
  for (const door of egressDoors(ec)) {
    const room = egressSideRoom(ec, door);
    if (!room) continue;
    const wall = ec.wallById.get(door.wallId);
    if (!wall) continue;
    const p = segPointAt({ a: wall.start, b: wall.end }, door.along);
    const faces = facesOf(ec, room);
    // Prefer a face of the door's own wall that actually spans the opening
    const onWall = faces
      .filter(f => f.wallId === door.wallId)
      .map(f => ({ face: f, raw: projectAlong(f.seg, p) }))
      .sort((a, b) => outsideBy(a.raw, a.face.length) - outsideBy(b.raw, b.face.length));
    const raw = onWall.length > 0
      ? { face: onWall[0].face, along: onWall[0].raw }
      : nearestFace(faces, p, 0.3);
    if (!raw) continue;
    // keep the sign clear of the corner so its body stays inside the room
    const margin = Math.min(0.25, raw.face.length / 3);
    const hit = { face: raw.face, along: Math.max(margin, Math.min(raw.face.length - margin, raw.along)) };
    addDevice(ec, room.storey, 'exit-sign', anchorOnFace(hit.face, hit.along, EXIT_SIGN_Z), hit.face.rotation, {
      roomId: room.id, wallId: hit.face.wallId || undefined, want: 'life-safety',
      note: `ELE-08 exit sign over ${door.id} (IBC §1013 / BS 5266 running-man)`,
    });
    signs++;
    const inward = hit.face.inward;
    const at: Vec3 = [
      segPointAt(hit.face.seg, hit.along)[0] + inward[0] * 0.8,
      segPointAt(hit.face.seg, hit.along)[1] + inward[1] * 0.8,
      ceilingOf(ec, room),
    ];
    addDevice(ec, room.storey, 'light-emergency', at, 0, {
      roomId: room.id, want: 'life-safety',
      note: `ELE-08 emergency luminaire at the ${door.type === 'building-entry' ? 'exit discharge' : 'stair door'}`,
    });
    emergency++;
  }
  return { signs, emergency };
}

/** How far outside [0, length] a projection falls (0 when the face spans the point) */
function outsideBy(along: number, length: number): number {
  return Math.max(0, -along, along - length);
}

function projectAlong(seg: Segment2, p: Vec2): number {
  const dx = seg.b[0] - seg.a[0];
  const dy = seg.b[1] - seg.a[1];
  const L = Math.hypot(dx, dy);
  if (L < 1e-9) return 0;
  return ((p[0] - seg.a[0]) * dx + (p[1] - seg.a[1]) * dy) / L;
}

/** Intercom panel at the main entrance (multi-dwelling door entry) */
export function generateEntryIntercom(ec: ElecCtx): void {
  if (ec.ctx.typology.access === 'direct') return;
  const lobby = ec.arch.rooms.find(r => r.type === 'lobby')
    ?? ec.arch.rooms.find(r => r.type === 'lift-lobby')
    ?? ec.arch.rooms.find(r => r.type === 'mail');
  if (!lobby) return;
  const entry = ec.arch.doors.find(d => d.type === 'building-entry' && (d.toRoomId === lobby.id || d.fromRoomId === lobby.id))
    ?? ec.arch.doors.find(d => d.type === 'building-entry');
  const faces = facesOf(ec, lobby);
  const wall = entry ? ec.wallById.get(entry.wallId) : undefined;
  const p = wall && entry ? segPointAt({ a: wall.start, b: wall.end }, entry.along) : null;
  const hit = p ? nearestFace(faces, p, 0.4) : nearestFace(faces, [lobby.rect.x + lobby.rect.w / 2, lobby.rect.y + lobby.rect.h / 2], 0.4);
  if (!hit) return;
  const along = Math.max(0.2, Math.min(hit.face.length - 0.2, hit.along + 1.0));
  addDevice(ec, lobby.storey, 'intercom', anchorOnFace(hit.face, along, 1.4), hit.face.rotation, {
    roomId: lobby.id, wallId: hit.face.wallId || undefined, name: 'Door-entry panel',
    note: 'One call button per dwelling, lobby door release',
  });
}

// ----------------------------------------------------------------------------
// Site lighting
// ----------------------------------------------------------------------------

export function generateSiteLighting(ec: ElecCtx): { exterior: number; bollards: number; poles: number } {
  const site = ec.ctx.site;
  const ground = ec.storeys.find(s => s.index === 0)?.id ?? ec.storeys[0]?.id ?? SITE_STOREY;
  let exterior = 0;
  for (const e of site.entrances ?? []) {
    const n = sideNormal(e.side);
    const along: Vec2 = [-n[1], n[0]];
    const anchor: Vec3 = [e.position[0] + along[0] * 0.9, e.position[1] + along[1] * 0.9, DEVICE_Z_EXTERIOR];
    addDevice(ec, ground, 'light-exterior', anchor, rotationForInward(n), {
      unitId: e.unitId, want: 'house-lighting',
      name: `Exterior luminaire at ${e.type} entrance`,
      note: 'ELE-01 luminaire beside every entrance, 2.2 m AFF',
    });
    exterior++;
  }
  let bollards = 0;
  if (ec.detail !== 'low') {
    for (const path of site.paths ?? []) {
      if (Math.max(path.w, path.h) < 4) continue;
      for (const p of alongLongAxis(path, 8, 1)) {
        addDevice(ec, SITE_STOREY, 'light-bollard', [p[0], p[1], 0.5], 0, {
          want: 'house-lighting', note: 'Path bollard at 8 m centres',
        });
        bollards++;
      }
    }
  }
  let poles = 0;
  const lot = site.parking;
  if (lot && lot.spaces.length > 0) {
    const bounds = rectUnionBounds([...lot.spaces.map(s => s.rect), ...lot.aisles]);
    const n = Math.max(1, Math.ceil(lot.spaces.length / 20));
    const horizontal = bounds.w >= bounds.h;
    for (const t of runPositions(horizontal ? bounds.w : bounds.h, (horizontal ? bounds.w : bounds.h) / n, n)) {
      const p: Vec2 = horizontal ? [bounds.x + t, bounds.y + bounds.h / 2] : [bounds.x + bounds.w / 2, bounds.y + t];
      addDevice(ec, lot.storey || SITE_STOREY, 'light-pole', [p[0], p[1], 0], 0, {
        want: 'house-lighting', note: 'ELE-10/ELE-01 one 6 m pole per 20 stalls',
      });
      poles++;
    }
  }
  return { exterior, bollards, poles };
}

const DEVICE_Z_EXTERIOR = 2.2;

// ----------------------------------------------------------------------------
// Equipment connections
// ----------------------------------------------------------------------------

const DISCONNECT_EQUIPMENT: Record<string, number> = {
  'heat-pump-outdoor': 3500,
  'vrf-condenser': 12000,
  'rtu': 0,
  'ahu': 0,
  'erv': 300,
  'mvhr': 300,
  'exhaust-fan': 200,
  'fan-coil': 500,
  'ptac': 3000,
  'boiler': 1500,
  'chiller': 0,
  'heat-interface-unit': 200,
  'indoor-unit': 800,
  'range-hood': 200,
};

export interface EquipmentLoad {
  unitId?: string;
  va: number;
  kind: string;
}

/** Thermostats mirrored from mechanical, plus a disconnect within 1 m of every powered unit */
export function generateEquipmentDevices(ec: ElecCtx): EquipmentLoad[] {
  const loads: EquipmentLoad[] = [];
  const mech = ec.ctx.mech;
  if (mech) {
    for (const eq of mech.equipment) {
      if (eq.type === 'thermostat') {
        const z = eq.position[2] > 0.3 ? eq.position[2] : MOUNTING.thermostat;
        addDevice(ec, eq.storey, 'thermostat', [eq.position[0], eq.position[1], z], eq.rotation ?? 0, {
          roomId: eq.roomId, unitId: eq.unitId, want: null, va: 0, watts: 0,
          note: '24 V control from the air handler — no branch-circuit load',
        });
        continue;
      }
      const base = DISCONNECT_EQUIPMENT[eq.type];
      if (base === undefined) continue;
      const va = eq.capacityKw && eq.capacityKw > 0 ? Math.round(eq.capacityKw * 1000) : base;
      const anchor = disconnectAnchor(ec, eq.position, eq.width, eq.roomId);
      addDevice(ec, eq.storey, 'disconnect', anchor.p, anchor.r, {
        roomId: eq.roomId, unitId: eq.unitId, want: eq.unitId ? 'hvac' : null, va,
        name: `Disconnect — ${eq.type}`,
        note: 'NEC 440.14 / 430.102 within sight and 1 m of the equipment served',
      });
      loads.push({ unitId: eq.unitId, va, kind: eq.type });
    }
  }
  const plumb = ec.ctx.plumb;
  if (plumb) {
    for (const fx of plumb.fixtures) {
      const va = fx.type === 'water-heater' ? 4500 : fx.type === 'booster-pump' ? 3000 : 0;
      if (va === 0) continue;
      // Skip when a furniture-driven connection already exists close by
      const near = ec.devices.some(d => (d.type === 'disconnect' || d.type === 'receptacle')
        && d.storey === fx.storey && dist([d.position[0], d.position[1]], [fx.position[0], fx.position[1]]) < 1.5);
      if (near) {
        loads.push({ unitId: fx.unitId, va, kind: fx.type });
        continue;
      }
      const anchor = disconnectAnchor(ec, fx.position, fx.width, fx.roomId);
      addDevice(ec, fx.storey, 'disconnect', anchor.p, anchor.r, {
        roomId: fx.roomId, unitId: fx.unitId, want: fx.type === 'water-heater' ? 'water-heater' : null, va,
        name: `Disconnect — ${fx.type}`,
        note: 'NEC 422.31(B) disconnecting means within sight of the appliance',
      });
      loads.push({ unitId: fx.unitId, va, kind: fx.type });
    }
  }
  return loads;
}

/**
 * A disconnect goes on the wall beside the equipment it serves (within sight, NEC 440.14).
 * Roof and outdoor plant with no room falls back to a free-standing box 0.5 m to one side.
 */
function disconnectAnchor(ec: ElecCtx, position: Vec3, width: number, roomId?: string): { p: Vec3; r: number } {
  const room = roomId ? ec.roomById.get(roomId) : undefined;
  const p2: Vec2 = [position[0] + Math.max(0.5, width / 2 + 0.4), position[1]];
  if (room) {
    const faces = facesOf(ec, room);
    const hit = nearestFace(faces, p2, 0.3) ?? nearestFace(faces, [position[0], position[1]], 0.2);
    if (hit) {
      const q = segPointAt(hit.face.seg, hit.along);
      return { p: [q[0], q[1], MOUNTING.thermostat], r: hit.face.rotation };
    }
    // no usable face: keep the box inside the room footprint
    const r = room.rect;
    const clamped: Vec2 = [
      Math.min(Math.max(p2[0], r.x + 0.15), r.x + r.w - 0.15),
      Math.min(Math.max(p2[1], r.y + 0.15), r.y + r.h - 0.15),
    ];
    return { p: [clamped[0], clamped[1], MOUNTING.thermostat], r: 0 };
  }
  const z = position[2] > 0.3 ? position[2] + 1.0 : MOUNTING.thermostat;
  return { p: [p2[0], p2[1], z], r: 0 };
}

/** Smoke alarms and heat detectors for common storeys handled outside dwelling rooms */
export function commonAreaRooms(ec: ElecCtx, storey: string): RoomDef[] {
  return (ec.roomsByStorey.get(storey) ?? []).filter(r => !r.unitId && r.type !== 'corridor');
}

export function corridorDefsFor(ec: ElecCtx, storey: string): CorridorDef[] {
  return ec.floorByStorey.get(storey)?.corridors ?? [];
}
