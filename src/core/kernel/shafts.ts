/**
 * The single shaft-slot allocator (XD-04).
 *
 * v1 had three independent implementations of "pick a corner of the shaft" (`mechanical/context.ts` `shaftSlots`,
 * `mechanical/placement.ts` `shaftSlot`, `plumbing/storm.ts` `plumbingShaftCorner`), none of which knew about the
 * others and none of which reserved a footprint — so two Ø150 risers could be assigned the same 0.15 m corner.
 *
 * Here a shaft is split once, along its LONG axis, into four disciplinary zones in a fixed order
 * (plumbing 35 % | mechanical 35 % | electrical 22 % | trash 8 %, each at least 0.20 m), and each system is packed
 * inside its zone in `SHAFT_SYSTEM_ORDER` with a real footprint. The slot position is a pure function of the shaft
 * rect and the set of requests, so it is idempotent and independent of which discipline asks first.
 */
import type { Rect, ShaftDef, Vec2 } from '../types.ts';
import type { Ledger, RuleSet } from '../rules/types.ts';
import { cite } from '../rules/SOURCES.ts';
import type {
  Box3, Conflict, Reservation, ReserveRequest, ReserveResult, ShaftAllocator, ShaftSlot, ShaftSlotRequest,
  ShaftSystem, ShaftZone,
} from './types.ts';
import { SHAFT_SYSTEM_ORDER, SHAFT_ZONE_OF, isConflict } from './types.ts';

/** Zone shares along the shaft's long axis, in this fixed order. */
export const SHAFT_ZONE_ORDER: readonly ShaftZone[] = ['plumbing', 'mechanical', 'electrical', 'trash'];
export const SHAFT_ZONE_SHARE: Readonly<Record<ShaftZone, number>> = { plumbing: 0.35, mechanical: 0.35, electrical: 0.22, trash: 0.08 };
export const SHAFT_ZONE_MIN = 0.2;
export const SHAFT_SLOT_GAP = 0.05;

export const SHAFT_ZONE_SOURCE = cite('default', '(plumbing toward one end, electrical toward the other, mechanical in the middle — v1 convention, now with footprints)');

/** Nominal outside diameter (m) of one riser per system, used when a caller does not give a footprint. */
export const SYSTEM_OD: Readonly<Record<ShaftSystem, number>> = {
  'waste': 0.11, 'vent': 0.056, 'storm': 0.11, 'dcw': 0.054, 'dhw': 0.042, 'hwr': 0.028,
  'sprinkler': 0.06, 'standpipe': 0.114, 'gas': 0.034,
  'air-supply': 0.4, 'air-exhaust': 0.4, 'air-outdoor': 0.3, 'kitchen-exhaust': 0.25, 'dryer-exhaust': 0.15,
  'refrigerant': 0.05, 'hydronic': 0.09, 'stair-pressurisation': 0.5,
  'power': 0.3, 'data': 0.2, 'life-safety': 0.1,
  'trash': 0.6,
};

export const SYSTEM_OD_SOURCE: Readonly<Record<ShaftSystem, string>> = {
  'waste': cite('IPC 2021', 'Table 710.1(2) (Ø100 stack)'),
  'vent': cite('IPC 2021', 'Table 906.1'),
  'storm': cite('IPC 2021', 'Table 1106.2'),
  'dcw': cite('IPC 2021', 'Table E103.3(3)'),
  'dhw': cite('ASHRAE 90.1-2019', 'Table 6.8.3-1'),
  'hwr': cite('ASHRAE 90.1-2019', '§6.5.4.6'),
  'sprinkler': cite('NFPA 13 2022', '§28.2'),
  'standpipe': cite('NFPA 14 2019', '§7.6 (Ø100 class I)'),
  'gas': cite('BS 6891:2015', '§6'),
  'air-supply': cite('SMACNA 3rd ed.', 'Chapter 2'),
  'air-exhaust': cite('IMC 2021', '§403'),
  'air-outdoor': cite('ASHRAE 62.1-2019', '§6.2'),
  'kitchen-exhaust': cite('IMC 2021', '§505'),
  'dryer-exhaust': cite('IMC 2021', '§504.8'),
  'refrigerant': cite('IMC 2021', '§1107'),
  'hydronic': cite('IMC 2021', '§1202'),
  'stair-pressurisation': cite('IBC 2021', '§909.20'),
  'power': cite('NEC 2023', '368.10 (busway riser)'),
  'data': cite('EN 50174-2:2018', '§6'),
  'life-safety': cite('NEC 2023', '700.10'),
  'trash': cite('IBC 2021', '§713.13 (refuse chute Ø600)'),
};

interface Spot { x: number; y: number; w: number; d: number; }

interface ShaftState {
  shaft: ShaftDef;
  /** key = `${discipline}|${system}` */
  requests: Map<string, ShaftSlotRequest>;
  slots: Map<string, ShaftSlot>;
  reservations: Map<string, Reservation[]>;
}

/** Reservation boxes are rewritten when a canonically-earlier system joins a zone and shifts the packing. */
function setBoxes(res: Reservation, boxes: Box3[]): void {
  (res as { boxes: readonly Box3[] }).boxes = boxes;
}

export interface ShaftAllocatorOptions {
  rules: RuleSet;
  ledger: Ledger;
  reserve(req: ReserveRequest): ReserveResult;
  /** Per-storey band the riser passes through; a riser box spans the whole storey height */
  storeyHeight(storey: string): number;
}

/** The long axis of a rect ('x' when it is wider than deep). */
export function longAxisOf(r: Rect): 'x' | 'y' {
  return r.w >= r.h ? 'x' : 'y';
}

/** Zone rect for a discipline zone, split along the shaft's long axis in `SHAFT_ZONE_ORDER`. */
export function zoneRect(rect: Rect, zone: ZoneOf): Rect {
  const axis = longAxisOf(rect);
  const total = axis === 'x' ? rect.w : rect.h;
  const raw = SHAFT_ZONE_ORDER.map(z => Math.max(SHAFT_ZONE_MIN, total * SHAFT_ZONE_SHARE[z]));
  const sum = raw.reduce((a, b) => a + b, 0);
  const lens = sum > total ? raw.map(v => (v / sum) * total) : raw.map((v, idx) => v + ((total - sum) * SHAFT_ZONE_SHARE[SHAFT_ZONE_ORDER[idx]]));
  let cursor = axis === 'x' ? rect.x : rect.y;
  for (let idx = 0; idx < SHAFT_ZONE_ORDER.length; idx++) {
    const len = lens[idx];
    if (SHAFT_ZONE_ORDER[idx] === zone) {
      return axis === 'x' ? { x: cursor, y: rect.y, w: len, h: rect.h } : { x: rect.x, y: cursor, w: rect.w, h: len };
    }
    cursor += len;
  }
  return rect;
}

type ZoneOf = ShaftZone;

function systemIndex(s: ShaftSystem): number {
  const i = SHAFT_SYSTEM_ORDER.indexOf(s);
  return i < 0 ? SHAFT_SYSTEM_ORDER.length : i;
}

/** First-fit packing of a zone's requests along the zone's long axis. Deterministic in `SHAFT_SYSTEM_ORDER`. */
function packZone(zr: Rect, reqs: readonly ShaftSlotRequest[]): Map<string, Spot> {
  const axis = longAxisOf(zr);
  const along = axis === 'x' ? zr.w : zr.h;
  const across = axis === 'x' ? zr.h : zr.w;
  const ordered = [...reqs].sort((a, b) => {
    const d = systemIndex(a.system) - systemIndex(b.system);
    if (d !== 0) return d;
    return a.discipline < b.discipline ? -1 : a.discipline > b.discipline ? 1 : 0;
  });
  const out = new Map<string, Spot>();
  let cursor = 0;
  let row = 0;
  let rowAcross = 0;
  for (const r of ordered) {
    const wAlong = axis === 'x' ? r.w : r.d;
    const wAcross = axis === 'x' ? r.d : r.w;
    if (cursor + wAlong > along + 1e-9 && cursor > 0) {
      // next row, if the zone is deep enough
      row += rowAcross + SHAFT_SLOT_GAP;
      cursor = 0;
      rowAcross = 0;
    }
    if (cursor + wAlong > along + 1e-9 || row + wAcross > across + 1e-9) continue; // does not fit: no spot
    const alongMin = (axis === 'x' ? zr.x : zr.y) + cursor;
    // `wantWall` pushes the riser against the zone's outer face so it can be strapped to the shaft wall.
    const acrossMin = r.wantWall ? (axis === 'x' ? zr.y : zr.x) + row : (axis === 'x' ? zr.y : zr.x) + row + Math.max(0, (across - row - wAcross) / 2);
    out.set(`${r.discipline}|${r.system}`, axis === 'x'
      ? { x: alongMin, y: acrossMin, w: wAlong, d: wAcross }
      : { x: acrossMin, y: alongMin, w: wAcross, d: wAlong });
    cursor += wAlong + SHAFT_SLOT_GAP;
    rowAcross = Math.max(rowAcross, wAcross);
  }
  return out;
}

export function createShaftAllocator(o: ShaftAllocatorOptions): ShaftAllocator & { registered(): readonly ShaftDef[] } {
  const shafts = new Map<string, ShaftState>();

  const boxesFor = (spot: Spot, storeys: readonly string[]): { storey: string; box: Box3 }[] =>
    storeys.map(s => ({ storey: s, box: { x: spot.x, y: spot.y, z: 0, w: spot.w, d: spot.d, h: Math.max(0.1, o.storeyHeight(s)) } }));

  const repack = (st: ShaftState): void => {
    for (const zone of SHAFT_ZONE_ORDER) {
      const zr = zoneRect(st.shaft.rect, zone);
      const reqs = [...st.requests.values()].filter(r => SHAFT_ZONE_OF[r.system] === zone);
      if (reqs.length === 0) continue;
      const packed = packZone(zr, reqs);
      for (const [key, spot] of packed) {
        const existing = st.slots.get(key);
        const req = st.requests.get(key);
        if (!req) continue;
        const xy: Vec2 = [spot.x + spot.w / 2, spot.y + spot.d / 2];
        if (existing) {
          existing.xy = xy;
          existing.w = spot.w;
          existing.d = spot.d;
          for (const res of st.reservations.get(key) ?? []) {
            setBoxes(res, boxesFor(spot, [res.storey]).map(b => b.box));
          }
        }
      }
    }
  };

  const reserveSlot = (st: ShaftState, key: string, req: ShaftSlotRequest, spot: Spot): Reservation | Conflict => {
    const made: Reservation[] = [];
    for (const b of boxesFor(spot, req.storeys)) {
      const r = o.reserve({
        owner: req.discipline, kind: kindOfSystem(req.system),
        storey: b.storey, container: 'shaft', containerId: st.shaft.id, boxes: [b.box],
        note: `riser ${req.system} in shaft ${st.shaft.id}`,
      });
      if (isConflict(r)) return r;
      made.push(r);
    }
    if (made.length === 0) {
      return { kind: 'conflict', reason: 'no-shaft', with: [st.shaft.id], message: `shaft ${st.shaft.id} has no storeys for ${req.system}`, ruleId: 'XD-04.shaftArea' };
    }
    st.reservations.set(key, made);
    return made[0];
  };

  return {
    register(shaft: ShaftDef): void {
      const prev = shafts.get(shaft.id);
      if (prev) {
        prev.shaft = shaft;
        repack(prev);
        return;
      }
      shafts.set(shaft.id, { shaft, requests: new Map(), slots: new Map(), reservations: new Map() });
    },

    slot(req: ShaftSlotRequest): ShaftSlot | Conflict {
      const st = shafts.get(req.shaftId);
      if (!st) {
        return { kind: 'conflict', reason: 'no-shaft', with: [req.shaftId], message: `no shaft ${req.shaftId} is registered`, ruleId: 'XD-04.shaftExists' };
      }
      if (st.shaft.purpose === 'elevator') {
        return {
          kind: 'conflict', reason: 'no-shaft', with: [req.shaftId],
          message: `shaft ${req.shaftId} is a hoistway: it shall contain no piping or ducting not serving the hoistway`,
          ruleId: 'XD-04.hoistway',
        };
      }
      const key = `${req.discipline}|${req.system}`;
      const existing = st.slots.get(key);
      if (existing) return existing;

      st.requests.set(key, req);
      const zone = SHAFT_ZONE_OF[req.system];
      const zr = zoneRect(st.shaft.rect, zone);
      const packed = packZone(zr, [...st.requests.values()].filter(r => SHAFT_ZONE_OF[r.system] === zone));
      const spot = packed.get(key);
      if (!spot) {
        st.requests.delete(key);
        const area = st.shaft.rect.w * st.shaft.rect.h;
        const n = [...st.requests.values()].filter(r => SHAFT_ZONE_OF[r.system] === zone).length + 1;
        return {
          kind: 'conflict', reason: 'shaft-full', with: [req.shaftId],
          message: `shaft ${req.shaftId} ${zone} zone cannot fit ${req.system}: ${n} systems in ${zr.w.toFixed(2)} × ${zr.h.toFixed(2)} m (shaft ${area.toFixed(2)} m²)`,
          ruleId: 'XD-04.shaftArea',
        };
      }
      const res = reserveSlot(st, key, req, spot);
      if (isConflict(res)) {
        st.requests.delete(key);
        return res;
      }
      const slot: ShaftSlot = {
        shaftId: st.shaft.id,
        discipline: req.discipline,
        system: req.system,
        xy: [spot.x + spot.w / 2, spot.y + spot.d / 2],
        w: spot.w,
        d: spot.d,
        zone,
        storeys: req.storeys,
        reservationId: res.id,
      };
      st.slots.set(key, slot);
      repack(st);
      return slot;
    },

    slotsOf(shaftId: string): readonly ShaftSlot[] {
      const st = shafts.get(shaftId);
      if (!st) return [];
      return [...st.slots.values()].sort((a, b) => {
        const d = systemIndex(a.system) - systemIndex(b.system);
        return d !== 0 ? d : a.discipline < b.discipline ? -1 : 1;
      });
    },

    utilisation(shaftId: string): number {
      const st = shafts.get(shaftId);
      if (!st) return 0;
      const area = st.shaft.rect.w * st.shaft.rect.h;
      if (area <= 0) return 0;
      let used = 0;
      for (const s of st.slots.values()) used += s.w * s.d;
      return used / area;
    },

    nearestWithRoom(p: Vec2, req: Omit<ShaftSlotRequest, 'shaftId'>): string | null {
      const zone = SHAFT_ZONE_OF[req.system];
      const candidates = [...shafts.values()]
        .filter(st => st.shaft.purpose !== 'elevator')
        .filter(st => {
          const zr = zoneRect(st.shaft.rect, zone);
          const reqs = [...st.requests.values()].filter(r => SHAFT_ZONE_OF[r.system] === zone);
          const trial: ShaftSlotRequest = { ...req, shaftId: st.shaft.id };
          return packZone(zr, [...reqs, trial]).has(`${req.discipline}|${req.system}`);
        })
        .map(st => {
          const c: Vec2 = [st.shaft.rect.x + st.shaft.rect.w / 2, st.shaft.rect.y + st.shaft.rect.h / 2];
          return { id: st.shaft.id, d: Math.hypot(c[0] - p[0], c[1] - p[1]) };
        })
        .sort((a, b) => (Math.abs(a.d - b.d) > 1e-6 ? a.d - b.d : a.id < b.id ? -1 : 1));
      return candidates.length > 0 ? candidates[0].id : null;
    },

    registered(): readonly ShaftDef[] {
      return [...shafts.values()].map(s => s.shaft).sort((a, b) => (a.id < b.id ? -1 : 1));
    },
  };
}

/** Element kind a riser of this system is modelled as (for band/keep-out checks). */
export function kindOfSystem(s: ShaftSystem): import('./types.ts').ElementKind {
  switch (s) {
    case 'waste': return 'waste';
    case 'vent': return 'vent';
    case 'storm': return 'storm';
    case 'dcw': return 'dcw';
    case 'dhw': return 'dhw';
    case 'hwr': return 'hwr';
    case 'gas': return 'gas';
    case 'sprinkler': return 'sprinkler-main';
    case 'standpipe': return 'standpipe';
    case 'power': return 'busduct';
    case 'data': return 'tray-data';
    case 'life-safety': return 'conduit';
    case 'trash': return 'shaft-void';
    default: return 'duct';
  }
}
