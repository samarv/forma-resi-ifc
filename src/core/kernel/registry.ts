/**
 * The reservation registry — `createKernel`.
 *
 * Every MEP element is emitted inside a reservation of its own discipline: a band (Z extent) and, for runs along a
 * corridor, a lane (lateral extent) inside it; risers get a shaft slot, dwelling stacks a chase, penetrations a
 * sleeve. Because bands are disjoint in Z, lanes are disjoint laterally inside a band, shaft zones are disjoint in
 * XY and a dwelling has exactly one chase, **two ordinary reservations cannot overlap by construction** — so the
 * kernel never runs a pairwise clash test. The only pairwise work is against `keepout` reservations (structure,
 * hoistways, electrical dedicated space), through a 2 m XY grid per storey.
 *
 * Determinism: reservation ids are a plain sequence; every allocator is keyed by a canonical constant order
 * (`SHAFT_SYSTEM_ORDER`, `Lane.systemOrder`) and memoised, so the same spec produces the same reservations
 * regardless of which discipline asks first.
 */
import type { RoomType, Segment2, StoreyDef, Vec2, Vec3 } from '../types.ts';
import type { Deviation, Ledger } from '../rules/types.ts';
import type {
  Box3, Chase, ChaseRequest, Conflict, Crossing, CrossingRequest, ElementKind, KeepOutRequest, Kernel,
  KernelOptions, Lane, LaneRun, LaneRunRequest, LaneSet, Reservation, ReserveRequest, ReserveResult, Riser,
  RiserRequest, Sleeve, SleeveRequest, StoreyProfile,
} from './types.ts';
import { isConflict } from './types.ts';
import { stackProfile } from './profiles.ts';
import { LateralAllocator, StationAllocator, laneBoxes, laneSetFor, lanePathIn, laneZ } from './lanes.ts';
import { createShaftAllocator } from './shafts.ts';
import { createChaseAllocator } from './chases.ts';
import { createSleeveAllocator } from './sleeves.ts';
import { GRID, boxesOverlap, createBoxIndex, validateElements } from './validate.ts';

/** Default band purpose for a kind when a reserve request does not name one. */
export const PURPOSE_OF: Readonly<Partial<Record<ElementKind, import('./types.ts').BandPurpose>>> = {
  'slab': 'structure', 'beam': 'structure', 'column': 'structure', 'drop-panel': 'structure',
  'duct': 'service', 'duct-fitting': 'service', 'fan': 'service', 'ahu': 'equipment', 'jet-fan': 'duct',
  'air-terminal': 'ceiling-void',
  'waste': 'crossing', 'vent': 'crossing', 'storm': 'crossing', 'trench-drain': 'gravity-drain',
  'dcw': 'service', 'dhw': 'service', 'hwr': 'service', 'gas': 'service',
  'sprinkler-main': 'sprinkler', 'sprinkler-branch': 'sprinkler', 'sprinkler-head': 'ceiling-void',
  'standpipe': 'service',
  'tray-power': 'service', 'tray-data': 'crossing', 'conduit': 'ceiling-void', 'busduct': 'service',
  'panel': 'ceiling-void', 'switchgear': 'equipment',
  'light': 'lighting', 'sensor': 'ceiling-void', 'ev-charger': 'tray',
  'pump': 'equipment', 'tank': 'equipment', 'sump': 'equipment', 'ejector': 'equipment', 'plinth': 'equipment',
  'shaft-void': 'clear', 'wall': 'clear',
};

const TOL = 1e-6;

function segLen(s: Segment2): number {
  return Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
}

function centrelineLength(cl: readonly Segment2[]): number {
  let l = 0;
  for (const s of cl) l += segLen(s);
  return l;
}

/** Point and direction at an arc-length station along a polyline of segments. */
function atStation(cl: readonly Segment2[], station: number): { p: Vec2; dir: Vec2 } {
  let rest = Math.max(0, station);
  for (const s of cl) {
    const l = segLen(s);
    if (l <= TOL) continue;
    const dir: Vec2 = [(s.b[0] - s.a[0]) / l, (s.b[1] - s.a[1]) / l];
    if (rest <= l) return { p: [s.a[0] + dir[0] * rest, s.a[1] + dir[1] * rest], dir };
    rest -= l;
  }
  const last = cl[cl.length - 1];
  if (!last) return { p: [0, 0], dir: [1, 0] };
  const l = segLen(last) || 1;
  return { p: last.b, dir: [(last.b[0] - last.a[0]) / l, (last.b[1] - last.a[1]) / l] };
}

/** Monotonic fall along a path: each horizontal leg drops `slope` × its plan length. */
export function applyFallLocal(path: readonly Vec3[], slope: number, startZ: number): Vec3[] {
  const out: Vec3[] = [];
  let z = startZ;
  for (let i = 0; i < path.length; i++) {
    if (i === 0) {
      out.push([path[0][0], path[0][1], z]);
      continue;
    }
    const a = path[i - 1];
    const b = path[i];
    z -= slope * Math.hypot(b[0] - a[0], b[1] - a[1]);
    out.push([b[0], b[1], z]);
  }
  return out;
}

export function createKernel(o: KernelOptions): Kernel {
  const reservations: Reservation[] = [];
  const keepOutIndex = new Map<string, { index: ReturnType<typeof createBoxIndex>; items: { box: Box3; res: Reservation }[] }>();
  const profileMemo = new Map<string, StoreyProfile>();
  const laneSetMemo = new Map<string, LaneSet>();
  const lateral = new Map<string, LateralAllocator>();
  const stations = new Map<string, StationAllocator>();
  const storeyById = new Map<string, StoreyDef>();
  for (const s of o.storeys) storeyById.set(s.id, s);
  let seq = 0;
  let laneRuns = 0;
  let crossings = 0;
  let conflicts = 0;

  const issue = (d: Deviation): void => {
    o.ledger.addOnce(`${d.ruleId}|${d.storey ?? ''}|${d.message}`, d);
  };

  const storeyHeight = (storey: string): number =>
    o.presize.byStorey.get(storey)?.floorToFloor ?? storeyById.get(storey)?.height ?? 3.0;

  const profileIdOf = (storey: string, roomType?: RoomType): import('./types.ts').ProfileId => {
    const sizing = o.presize.byStorey.get(storey);
    if (roomType) {
      const use = sizing?.use ?? storeyById.get(storey)?.use ?? 'residential';
      return o.profiles.resolve(use, roomType);
    }
    if (sizing) return sizing.profileId;
    const use = storeyById.get(storey)?.use ?? 'residential';
    return o.profiles.resolve(use);
  };

  const profileOf = (storey: string, roomType?: RoomType): StoreyProfile => {
    const pid = profileIdOf(storey, roomType);
    const key = `${storey}|${pid}`;
    const hit = profileMemo.get(key);
    if (hit) return hit;
    const sizing = o.presize.byStorey.get(storey);
    const def = o.storeys.find(s => s.id === storey);
    const { resolved } = stackProfile({
      profile: o.profiles.profile(pid),
      storey,
      floorToFloor: sizing?.floorToFloor ?? def?.height ?? 3.0,
      slabTAbove: sizing?.slabTAbove ?? o.presize.sizes.slabT,
      beamDAbove: sizing?.beamDAbove ?? 0,
      beamDAboveUnit: sizing?.beamDAboveUnit ?? 0,
      // `StoreySizing.transferZoneDepth` is the WHOLE zone (transfer slab + transfer beam). `soffitZ` has already
      // taken the slab off, so only the beam hangs below it — the same number the pre-sizing itself passes.
      transferZoneDepth: sizing?.isTransferBelow
        ? Math.max(0, (sizing.transferZoneDepth ?? o.presize.transferZoneDepth) - sizing.slabTAbove)
        : 0,
      rules: o.rules,
    });
    for (const i of resolved.issues) {
      issue({
        severity: i.severity, ruleId: i.ruleId, discipline: i.discipline, storey: i.storey,
        message: i.message, observed: i.observed, limit: i.limit, source: i.source, resolution: i.resolution,
      });
    }
    profileMemo.set(key, resolved);
    return resolved;
  };

  const corridorWidthOn = (storey: string): number => {
    const floor = o.arch?.floors.find(f => f.storey === storey);
    const w = floor?.corridors?.[0]?.width;
    if (w && w > TOL) return w;
    const spine = o.site.massing.corridors[0];
    if (spine && spine.width > TOL) return spine.width;
    return o.rules.num('ARC-03.corridorWidth', 1.5);
  };

  const laneSetOf = (storey: string): LaneSet => {
    const pid = profileIdOf(storey);
    const key = `${storey}|${pid}`;
    const hit = laneSetMemo.get(key);
    if (hit) return hit;
    const { set, issues } = laneSetFor(pid, corridorWidthOn(storey), o.rules);
    for (const i of issues) issue({ ...i, storey });
    laneSetMemo.set(key, set);
    return set;
  };

  const laneOf = (storey: string, laneId: string): Lane | null =>
    laneSetOf(storey).lanes.find(l => l.id === laneId) ?? null;

  const record = (req: ReserveRequest, shift: Reservation['shift']): Reservation => {
    seq += 1;
    const res: Reservation = {
      id: `RSV-${String(seq).padStart(4, '0')}`,
      owner: req.owner,
      kind: req.kind,
      purpose: req.purpose ?? PURPOSE_OF[req.kind] ?? 'service',
      storey: req.storey,
      container: req.container,
      containerId: req.containerId ?? null,
      boxes: req.boxes,
      shift,
      bans: req.bans,
      note: req.note,
    };
    reservations.push(res);
    if (res.container === 'keepout') {
      let bucket = keepOutIndex.get(res.storey);
      if (!bucket) {
        bucket = { index: createBoxIndex(), items: [] };
        keepOutIndex.set(res.storey, bucket);
      }
      for (const b of res.boxes) {
        bucket.index.insert(b, bucket.items.length);
        bucket.items.push({ box: b, res });
      }
    }
    return res;
  };

  const keepOutHit = (storey: string, boxes: readonly Box3[], kind: ElementKind, owner: string): Reservation | null => {
    const bucket = keepOutIndex.get(storey);
    if (!bucket) return null;
    for (const box of boxes) {
      for (const idx of bucket.index.query(box)) {
        const item = bucket.items[idx];
        if (item.res.owner === owner) continue;
        if (!(item.res.bans ?? []).includes(kind)) continue;
        if (boxesOverlap(box, item.box, 1e-4)) return item.res;
      }
    }
    return null;
  };

  const reserve = (req: ReserveRequest): ReserveResult => {
    if (req.boxes.length === 0) {
      conflicts += 1;
      return { kind: 'conflict', reason: 'outside-band', with: [], message: `${req.kind} reservation on ${req.storey} has no boxes`, ruleId: 'XD-02.inBand' };
    }
    if (req.container === 'band') {
      const profile = profileOf(req.storey, req.roomType);
      const purpose = req.purpose ?? PURPOSE_OF[req.kind] ?? 'service';
      const band = profile.band(purpose);
      if (!band || band.dropped) {
        conflicts += 1;
        return {
          kind: 'conflict', reason: 'no-band', with: [], ruleId: 'XD-02.bandExists',
          message: `${profile.profileId} on ${req.storey} has no ${purpose} band for ${req.kind}${band ? ' (it was dropped to hold the clear height)' : ''}`,
        };
      }
      if (!band.allows.includes(req.kind)) {
        conflicts += 1;
        return {
          kind: 'conflict', reason: 'kind-not-allowed', with: [band.id], ruleId: 'XD-02.bandAllows',
          message: `band ${band.id} does not allow ${req.kind} (allows ${band.allows.join(', ') || 'nothing'})`,
        };
      }
      for (const b of req.boxes) {
        if (b.z < band.z0 - 0.02 || b.z + b.h > band.z1 + 0.02) {
          conflicts += 1;
          return {
            kind: 'conflict', reason: 'outside-band', with: [band.id], ruleId: 'XD-02.inBand',
            message: `${req.kind} box [${b.z.toFixed(3)}, ${(b.z + b.h).toFixed(3)}] is outside band ${band.id} [${band.z0.toFixed(3)}, ${band.z1.toFixed(3)}]`,
            suggestion: [{ ...b, z: band.z1 - b.h, h: b.h }],
          };
        }
      }
      const hit = keepOutHit(req.storey, req.boxes, req.kind, req.owner);
      if (hit) {
        conflicts += 1;
        return {
          kind: 'conflict', reason: 'keepout', with: [hit.id], ruleId: hit.note?.includes('110.26') ? 'ELE-13.dedicatedSpace' : 'XD-S5.noPenetration',
          message: `${req.kind} is banned inside keep-out ${hit.id} (${hit.note ?? hit.kind})`,
        };
      }
      return record({ ...req, containerId: req.containerId ?? band.id, purpose }, { lateral: 0, along: 0, vertical: 0 });
    }
    if (req.container !== 'keepout') {
      const hit = keepOutHit(req.storey, req.boxes, req.kind, req.owner);
      if (hit) {
        conflicts += 1;
        return {
          kind: 'conflict', reason: 'keepout', with: [hit.id], ruleId: hit.note?.includes('110.26') ? 'ELE-13.dedicatedSpace' : 'XD-S5.noPenetration',
          message: `${req.kind} is banned inside keep-out ${hit.id} (${hit.note ?? hit.kind})`,
        };
      }
    }
    return record(req, { lateral: 0, along: 0, vertical: 0 });
  };

  const shafts = createShaftAllocator({ rules: o.rules, ledger: o.ledger, reserve, storeyHeight });
  for (const s of o.arch?.shafts ?? []) shafts.register(s);

  const chases = createChaseAllocator({ rules: o.rules, ledger: o.ledger, reserve, storeyHeight });
  const sleeves = createSleeveAllocator({ rules: o.rules, ledger: o.ledger, reserve });

  const reserveLaneRun = (req: LaneRunRequest): LaneRun | Conflict => {
    const lane = laneOf(req.storey, req.laneId);
    if (!lane) {
      conflicts += 1;
      return { kind: 'conflict', reason: 'no-band', with: [], ruleId: 'XD-02.laneWidth', message: `no lane ${req.laneId} on ${req.storey}` };
    }
    const profile = profileOf(req.storey);
    let band = profile.band(lane.bandPurpose);
    if (!band || band.dropped) {
      const fall = profile.band('crossing');
      if (fall && !fall.dropped && fall.allows.includes(req.kind)) band = fall;
      else {
        conflicts += 1;
        return { kind: 'conflict', reason: 'no-band', with: [], ruleId: 'XD-02.bandExists', message: `${profile.profileId} on ${req.storey} has no ${lane.bandPurpose} band for lane ${lane.id}` };
      }
    }
    const key = `${req.storey}|${lane.id}`;
    let alloc = lateral.get(key);
    if (!alloc) {
      alloc = new LateralAllocator(lane);
      lateral.set(key, alloc);
    }
    let span = alloc.claim(req.systemKey, Math.min(req.width, lane.width));
    let usedBand = band;
    if (!span) {
      const fall = profile.band('crossing');
      if (fall && !fall.dropped && fall.allows.includes(req.kind)) {
        usedBand = fall;
        span = { a: lane.offset - lane.minWidth / 2, b: lane.offset + lane.minWidth / 2, centre: lane.offset };
        issue({
          severity: 'info', ruleId: 'XD-02.laneWidth', discipline: 'xd', storey: req.storey,
          message: `lane ${lane.id} was full for ${req.systemKey}; the run dropped into the ${fall.id} band`,
          resolution: { id: 'drop-band', note: fall.id },
        });
      } else {
        conflicts += 1;
        return { kind: 'conflict', reason: 'lane-full', with: [lane.id], ruleId: 'XD-02.laneWidth', message: `lane ${lane.id} on ${req.storey} has no room for ${req.systemKey} (${req.width.toFixed(2)} m)` };
      }
    }
    const width = Math.max(0.02, span.b - span.a);
    const height = Math.min(req.height > 0 ? req.height : lane.height, Math.max(0.02, usedBand.z1 - usedBand.z0));
    const z = laneZ(usedBand, height, lane.vAlign);
    const path = lanePathIn(req.centerline, lane, z, span.centre - lane.offset);
    const boxes = laneBoxes(path, width, height);
    const res = reserve({
      owner: req.owner, kind: req.kind, storey: req.storey, container: 'band', containerId: usedBand.id,
      purpose: usedBand.purpose, boxes, note: req.name ?? `${req.systemKey} in lane ${lane.id}`,
    });
    if (isConflict(res)) return res;
    if (Math.abs(span.centre - lane.offset) > TOL) {
      (res as { shift: Reservation['shift'] }).shift = { lateral: span.centre - lane.offset, along: 0, vertical: 0 };
    }
    laneRuns += 1;
    return { path, width, height, lane, band: usedBand, reservation: res };
  };

  const reserveCrossing = (req: CrossingRequest): Crossing | Conflict => {
    const profile = profileOf(req.storey);
    const band = profile.band('crossing') ?? profile.band('gravity-drain');
    if (!band || band.dropped) {
      conflicts += 1;
      return { kind: 'conflict', reason: 'no-band', with: [], ruleId: 'XD-02.bandExists', message: `${profile.profileId} on ${req.storey} has no crossing band` };
    }
    if (!band.allows.includes(req.kind)) {
      conflicts += 1;
      return { kind: 'conflict', reason: 'kind-not-allowed', with: [band.id], ruleId: 'XD-02.bandAllows', message: `crossing band ${band.id} does not allow ${req.kind}` };
    }
    const key = `${req.storey}|${band.id}`;
    let alloc = stations.get(key);
    if (!alloc) {
      alloc = new StationAllocator(band.id, o.rules.num('XD-02.crossingPitch', 0.3));
      stations.set(key, alloc);
    }
    const hit = alloc.claim(req.systemKey, req.station, Math.max(req.width, 0.1));
    if (!hit) {
      conflicts += 1;
      return { kind: 'conflict', reason: 'band-full', with: [band.id], ruleId: 'XD-02.crossingPitch', message: `crossing band ${band.id} on ${req.storey} has no free station near ${req.station.toFixed(2)} m` };
    }
    const total = centrelineLength(req.centerline);
    const { p, dir } = atStation(req.centerline, Math.min(hit.station, total));
    const n: Vec2 = [-dir[1], dir[0]];
    const half = Math.max(req.length, 0.2) / 2;
    const height = Math.min(req.height > 0 ? req.height : band.depth, Math.max(0.02, band.z1 - band.z0));
    const z = band.z1 - height / 2;
    let path: Vec3[] = [
      [p[0] - n[0] * half, p[1] - n[1] * half, z],
      [p[0] + n[0] * half, p[1] + n[1] * half, z],
    ];
    if (req.slope && req.slope > 0) {
      const maxFall = Math.max(0, (band.z1 - band.z0) - height);
      const slope = Math.min(req.slope, maxFall / Math.max(0.2, 2 * half));
      path = applyFallLocal(path, slope, z);
    }
    const res = reserve({
      owner: req.owner, kind: req.kind, storey: req.storey, container: 'band', containerId: band.id,
      purpose: band.purpose, boxes: laneBoxes(path, Math.max(req.width, 0.05), height),
      note: `${req.systemKey} crossing at ${hit.station.toFixed(2)} m`,
    });
    if (isConflict(res)) return res;
    if (Math.abs(hit.shifted) > TOL) {
      (res as { shift: Reservation['shift'] }).shift = { lateral: 0, along: hit.shifted, vertical: 0 };
      issue({
        severity: 'info', ruleId: 'XD-02.crossingPitch', discipline: 'xd', storey: req.storey,
        message: `crossing ${req.systemKey} shifted ${(hit.shifted * 1000).toFixed(0)} mm along the corridor to clear an earlier crossing`,
        resolution: { id: 'shift-along-lane', from: Number(req.station.toFixed(3)), to: Number(hit.station.toFixed(3)) },
      });
    }
    crossings += 1;
    return { path, z, shiftedBy: hit.shifted, reservation: res };
  };

  const reserveRiser = (req: RiserRequest): Riser | Conflict => {
    let shaftId = req.shaftId ?? null;
    if (!shaftId && req.near) {
      shaftId = shafts.nearestWithRoom(req.near, {
        discipline: req.owner, system: req.system, w: req.w, d: req.d, storeys: req.storeys,
      });
    }
    if (!shaftId) {
      conflicts += 1;
      return { kind: 'conflict', reason: 'no-shaft', with: [], ruleId: 'XD-04.shaftExists', message: `no shaft with room for a ${req.system} riser (${req.w.toFixed(2)} × ${req.d.toFixed(2)} m)` };
    }
    const slot = shafts.slot({
      shaftId, discipline: req.owner, system: req.system, w: req.w, d: req.d, wantWall: true, storeys: req.storeys,
    });
    if (isConflict(slot)) {
      const bigger = req.near ? shafts.nearestWithRoom(req.near, { discipline: req.owner, system: req.system, w: req.w, d: req.d, storeys: req.storeys }) : null;
      if (bigger && bigger !== shaftId) {
        issue({
          severity: 'info', ruleId: 'XD-04.shaftOverflow', discipline: req.owner, storey: req.storeys[0],
          message: `${req.system} riser moved from shaft ${shaftId} to ${bigger}: the first shaft was full`,
          resolution: { id: 'enlarge-shaft', from: shaftId, to: bigger },
        });
        const retry = shafts.slot({ shaftId: bigger, discipline: req.owner, system: req.system, w: req.w, d: req.d, wantWall: true, storeys: req.storeys });
        if (!isConflict(retry)) {
          const res = reservations.find(r => r.id === retry.reservationId);
          return { slot: retry, reservation: res as Reservation };
        }
      }
      conflicts += 1;
      return slot;
    }
    const res = reservations.find(r => r.id === slot.reservationId);
    if (!res) {
      conflicts += 1;
      return { kind: 'conflict', reason: 'shaft-full', with: [shaftId], ruleId: 'XD-04.shaftArea', message: `shaft slot ${slot.system} in ${shaftId} has no reservation` };
    }
    return { slot, reservation: res };
  };

  const kernel: Kernel = {
    profileOf,
    laneSetOf,
    laneOf,
    reserve,
    reserveLaneRun,
    reserveCrossing,
    reserveRiser,
    shafts,
    chase(req: ChaseRequest): Chase | Conflict {
      return chases.chase(req);
    },
    chaseOf(unitId: string): Chase | null {
      return chases.chaseOf(unitId);
    },
    sleeve(req: SleeveRequest): Sleeve | Conflict {
      return sleeves.sleeve(req);
    },
    keepOut(k: KeepOutRequest): Reservation {
      return record({
        owner: k.owner, kind: k.kind, storey: k.storey, container: 'keepout', boxes: k.boxes,
        bans: k.bans, note: k.note, purpose: 'clear',
      }, { lateral: 0, along: 0, vertical: 0 });
    },
    reservations(): readonly Reservation[] {
      return reservations;
    },
    reservationsOn(storey: string, owner?: import('../types.ts').Discipline): readonly Reservation[] {
      return reservations.filter(r => r.storey === storey && (!owner || r.owner === owner));
    },
    validate(elements): import('../rules/types.ts').Issue[] {
      return validateElements({
        elements,
        reservations,
        profileOf: (storey: string) => (storeyById.has(storey) || o.presize.byStorey.has(storey) ? profileOf(storey) : null),
        ledger: o.ledger,
        cap: o.rules.num('XD-00.issueCapPerRule', 25),
      });
    },
    derived(): Record<string, number> {
      const keepOuts = reservations.filter(r => r.container === 'keepout').length;
      let shaftSlots = 0;
      for (const s of shafts.registered()) shaftSlots += shafts.slotsOf(s.id).length;
      return {
        reservations: reservations.length,
        keepOuts,
        laneRuns,
        crossings,
        shafts: shafts.registered().length,
        shaftSlots,
        chases: chases.all().length,
        sleeves: sleeves.all().length,
        conflicts,
        gridCell: GRID,
      };
    },
  };
  return kernel;
}
