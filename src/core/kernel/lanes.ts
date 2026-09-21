/**
 * Lanes — the lateral half of the coordination grid.
 *
 * A band gives a service its Z extent; a lane gives it a lateral extent *with a width*, measured from the corridor
 * centreline (positive toward `CorridorSpine.loaded === 'left'`). Because lanes inside one band are laterally
 * disjoint by construction and different bands are disjoint in Z, two reserved runs can never occupy the same space
 * — which is what removes the pairwise clash test from the kernel.
 *
 * v1 (`coordination.ts:39`) had four lane offsets with **no widths and one Z for pipes, sprinkler and tray**, so a
 * Ø150 storm main sat 0.20 m from the Ø50 sprinkler main at the same height, and the two tray centres were 0.15 m
 * apart while the trays themselves were 0.30 m and 0.20 m wide. Here every lane carries `width`/`minWidth`, and the
 * two trays are separated **vertically** (power in the service band, data in the crossing band) which is what gives
 * them their 0.15 m EMC separation (BS 7671 §528.1 permits separation by distance *or* by physical/vertical
 * separation) without needing a 2 m wide corridor.
 *
 * Allocation is call-order independent: each lane declares its systems in a canonical order with a nominal width, so
 * the k-th claimer always lands on the same sub-interval no matter which discipline asks first.
 */
import type { Segment2, Vec2, Vec3 } from '../types.ts';
import type { Issue, RuleSet } from '../rules/types.ts';
import { cite } from '../rules/SOURCES.ts';
import type { BandPurpose, Box3, Lane, LaneSet, LateralSpan, ProfileId, ResolvedBand } from './types.ts';

const TOL = 1e-9;

export interface LaneSystemSlot {
  /** System key a discipline passes to `reserveLaneRun` */
  key: string;
  /** Nominal lateral width this system takes inside the lane (m) */
  width: number;
  source: string;
}

/** Canonical system order + nominal widths per lane. The order is THE determinant of lateral position. */
export const LANE_SYSTEMS: Readonly<Record<string, readonly LaneSystemSlot[]>> = {
  'sprinkler': [
    { key: 'sprinkler-main', width: 0.08, source: cite('NFPA 13 2022', '§9.2.2 (Ø50 main + hanger)') },
    { key: 'sprinkler-branch', width: 0.04, source: cite('NFPA 13 2022', 'Table 9.2.2.1') },
  ],
  'duct': [
    { key: 'supply', width: 0.3, source: cite('SMACNA 3rd ed.', 'Chapter 2 (500 × 300 trunk + 50 mm insulation)') },
    { key: 'exhaust', width: 0.2, source: cite('IMC 2021', '§403') },
    { key: 'outdoor', width: 0.1, source: cite('ASHRAE 62.1-2019', '§6.2') },
  ],
  'gravity': [
    { key: 'waste', width: 0.14, source: cite('IPC 2021', 'Table 704.1 (Ø100 + fall allowance)') },
    { key: 'vent', width: 0.08, source: cite('IPC 2021', '§903') },
    { key: 'storm', width: 0.08, source: cite('IPC 2021', 'Table 1106.2') },
  ],
  'pressure': [
    { key: 'dcw', width: 0.09, source: cite('IPC 2021', '§305 (Ø50 + 25 mm insulation)') },
    { key: 'dhw', width: 0.08, source: cite('ASHRAE 90.1-2019', 'Table 6.8.3-1') },
    { key: 'hwr', width: 0.06, source: cite('ASHRAE 90.1-2019', '§6.5.4.6') },
    { key: 'gas', width: 0.04, source: cite('BS 6891:2015', '§8.7') },
    { key: 'standpipe', width: 0.03, source: cite('NFPA 14 2019', '§7.3') },
  ],
  'tray-power': [
    { key: 'power', width: 0.2, source: cite('NEC 2023', '392.18(A) (300 × 100 tray + 20 mm each side)') },
    { key: 'busduct', width: 0.1, source: cite('NEC 2023', '368.10') },
    { key: 'life-safety', width: 0.04, source: cite('NEC 2023', '700.10') },
  ],
  'tray-data': [
    { key: 'data', width: 0.2, source: cite('EN 50174-2:2018', 'Table 8 (200 × 50 tray)') },
  ],
  'exhaust': [
    { key: 'car-park-exhaust', width: 0.5, source: cite('IMC 2021', '§404.2') },
    { key: 'make-up', width: 0.2, source: cite('ASHRAE 62.1-2019', 'Table 6-4') },
  ],
  'lighting': [
    { key: 'lighting', width: 0.2, source: cite('IECC 2021', 'Table C405.3.2(2)') },
    { key: 'controls', width: 0.1, source: cite('NEC 2023', '314.23') },
  ],
  'drain': [
    { key: 'trench', width: 0.2, source: cite('IPC 2021', '§1101.2') },
    { key: 'storm', width: 0.1, source: cite('IPC 2021', 'Table 1106.2') },
  ],
  'landlord': [
    { key: 'duct', width: 0.3, source: cite('SMACNA 3rd ed.', 'Chapter 2') },
    { key: 'sprinkler-main', width: 0.1, source: cite('NFPA 13 2022', '§9.2.2') },
    { key: 'dcw', width: 0.1, source: cite('IPC 2021', '§305') },
    { key: 'waste', width: 0.1, source: cite('IPC 2021', 'Table 704.1') },
  ],
};

function systemOrderOf(laneId: string): readonly string[] {
  return (LANE_SYSTEMS[laneId] ?? []).map(s => s.key);
}

function lane(l: Omit<Lane, 'systemOrder'>): Lane {
  return { ...l, systemOrder: systemOrderOf(l.id) };
}

/**
 * The residential corridor lane set (nominal corridor 1.70 m; required 1.54 m).
 *
 * Lateral extents, service band:  pressure [-0.77,-0.47]  duct [-0.30,+0.30]  tray-power [+0.35,+0.69]
 *                crossing band:   gravity  [-0.60,-0.30]  tray-data  [+0.34,+0.56]
 *                sprinkler band:  sprinkler [-0.06,+0.06]
 */
const RESI_CORRIDOR_LANES: readonly Lane[] = [
  lane({
    id: 'sprinkler', owner: 'plumbing', bandPurpose: 'sprinkler',
    offset: 0, width: 0.12, minWidth: 0.1, height: 0.1, vAlign: 'top',
    allows: ['sprinkler-main', 'sprinkler-branch'],
    source: cite('NFPA 13 2022', '§8.6.4.1.1.1'),
  }),
  lane({
    id: 'duct', owner: 'mechanical', bandPurpose: 'service',
    offset: 0, width: 0.6, minWidth: 0.45, height: 0.3, vAlign: 'top',
    allows: ['duct', 'duct-fitting'],
    source: cite('SMACNA 3rd ed.', 'Chapter 2'),
  }),
  lane({
    id: 'pressure', owner: 'plumbing', bandPurpose: 'service',
    offset: -0.62, width: 0.3, minWidth: 0.2, height: 0.15, vAlign: 'middle',
    allows: ['dcw', 'dhw', 'hwr', 'gas', 'standpipe'],
    source: cite('ASHRAE 90.1-2019', 'Table 6.8.3-1'),
  }),
  lane({
    id: 'tray-power', owner: 'electrical', bandPurpose: 'service',
    offset: 0.52, width: 0.34, minWidth: 0.32, height: 0.1, vAlign: 'bottom',
    allows: ['tray-power', 'busduct', 'conduit'],
    source: cite('NEC 2023', '392.18(A)'),
  }),
  lane({
    id: 'gravity', owner: 'plumbing', bandPurpose: 'crossing',
    offset: -0.45, width: 0.3, minWidth: 0.22, height: 0.2, vAlign: 'top',
    allows: ['waste', 'vent', 'storm'],
    source: cite('IPC 2021', 'Table 704.1'),
  }),
  lane({
    id: 'tray-data', owner: 'electrical', bandPurpose: 'crossing',
    offset: 0.45, width: 0.22, minWidth: 0.2, height: 0.05, vAlign: 'bottom',
    allows: ['tray-data'],
    source: `${cite('BS 7671:2018+A2:2022', '§528.1')}; ${cite('EN 50174-2:2018', 'Table 8')}`,
  }),
];

const PARKING_LANES: readonly Lane[] = [
  lane({
    id: 'sprinkler', owner: 'plumbing', bandPurpose: 'sprinkler',
    offset: 0.6, width: 0.12, minWidth: 0.1, height: 0.1, vAlign: 'top',
    allows: ['sprinkler-main', 'sprinkler-branch'],
    source: cite('NFPA 13 2022', '§8.3.3'),
  }),
  lane({
    id: 'exhaust', owner: 'mechanical', bandPurpose: 'exhaust',
    offset: 0, width: 0.8, minWidth: 0.6, height: 0.4, vAlign: 'top',
    allows: ['duct', 'duct-fitting', 'fan'],
    source: cite('IMC 2021', '§404.2'),
  }),
  lane({
    id: 'lighting', owner: 'electrical', bandPurpose: 'lighting',
    offset: -0.6, width: 0.3, minWidth: 0.2, height: 0.12, vAlign: 'bottom',
    allows: ['light', 'sensor', 'conduit', 'tray-power'],
    source: cite('IECC 2021', 'Table C405.3.2(2)'),
  }),
  lane({
    id: 'drain', owner: 'plumbing', bandPurpose: 'gravity-drain',
    offset: 0, width: 0.3, minWidth: 0.2, height: 0.15, vAlign: 'bottom',
    allows: ['trench-drain', 'storm', 'waste'],
    source: cite('IPC 2021', '§1101.2'),
  }),
];

const RETAIL_LANES: readonly Lane[] = [
  lane({
    id: 'landlord', owner: 'mechanical', bandPurpose: 'landlord-service',
    offset: 0, width: 0.8, minWidth: 0.6, height: 0.3, vAlign: 'top',
    allows: ['duct', 'duct-fitting', 'sprinkler-main', 'dcw', 'waste', 'tray-power', 'standpipe'],
    source: cite('default', '(landlord base-build route, capped at the demise)'),
  }),
];

const LANE_SETS: Readonly<Record<string, { lanes: readonly Lane[]; overflowLaneId: string | null }>> = {
  'resi-corridor': { lanes: RESI_CORRIDOR_LANES, overflowLaneId: 'pressure' },
  'parking': { lanes: PARKING_LANES, overflowLaneId: null },
  'retail-shell': { lanes: RETAIL_LANES, overflowLaneId: null },
};

/** Lane set id used by a profile (null = the profile has no along-corridor lanes). */
export function laneSetIdFor(profileId: ProfileId): string | null {
  if (profileId === 'resi-corridor' || profileId === 'lobby' || profileId === 'amenity') return 'resi-corridor';
  if (profileId === 'parking' || profileId === 'basement-service') return 'parking';
  if (profileId === 'retail-shell') return 'retail-shell';
  return null;
}

export function requiredWidthOf(lanes: readonly Lane[]): number {
  let half = 0;
  for (const l of lanes) half = Math.max(half, Math.abs(l.offset) + l.width / 2);
  return 2 * half;
}

/**
 * Re-lay the lanes of one band side by side across the corridor, in canonical id order, centred on the centreline.
 * Used when a lane overflows into another band: the two lanes would otherwise be given offsets from different
 * tables and could overlap, and lateral disjointness inside a band is the invariant the whole kernel rests on.
 */
function repack(lanes: readonly Lane[], bandPurpose: BandPurpose, corridorWidth: number): Lane[] {
  const inBand = lanes.filter(l => l.bandPurpose === bandPurpose).sort((a, b) => (a.id < b.id ? -1 : 1));
  if (inBand.length < 2) return [...lanes];
  const total = inBand.reduce((s, l) => s + l.width, 0);
  const scale = corridorWidth > TOL && total > corridorWidth ? corridorWidth / total : 1;
  const widths = inBand.map(l => Math.max(l.minWidth, l.width * scale));
  const span = widths.reduce((a, b) => a + b, 0);
  let cursor = -span / 2;
  const offsets = new Map<string, { offset: number; width: number }>();
  for (let n = 0; n < inBand.length; n++) {
    offsets.set(inBand[n].id, { offset: cursor + widths[n] / 2, width: widths[n] });
    cursor += widths[n];
  }
  return lanes.map(l => {
    const hit = offsets.get(l.id);
    return hit && l.bandPurpose === bandPurpose ? { ...l, offset: Number(hit.offset.toFixed(4)), width: hit.width } : l;
  });
}

/**
 * The lane set for a profile at a real corridor width. Offsets are scaled and widths floored at `minWidth` when the
 * corridor is narrower than required; if even the minimum widths do not fit, the overflow lane is reported so the
 * registry can drop it into the crossing band.
 */
export function laneSetFor(profileId: ProfileId, corridorWidth: number, rules: RuleSet): { set: LaneSet; issues: Omit<Issue, 'id'>[] } {
  const setId = laneSetIdFor(profileId);
  const issues: Omit<Issue, 'id'>[] = [];
  if (!setId) {
    return { set: { id: 'none', lanes: [], requiredCorridorWidth: 0, overflowLaneId: null }, issues };
  }
  const def = LANE_SETS[setId];
  const required = requiredWidthOf(def.lanes);
  const width = corridorWidth > TOL ? corridorWidth : required;
  const minRequired = requiredWidthOf(def.lanes.map(l => ({ ...l, width: l.minWidth })));

  let lanes = def.lanes;
  if (width < required - 1e-6) {
    const scale = Math.max(0.1, width / required);
    lanes = def.lanes.map(l => ({ ...l, offset: l.offset * scale, width: Math.max(l.minWidth, l.width * scale) }));
    issues.push({
      severity: 'info', ruleId: 'XD-02.laneWidth', discipline: 'xd',
      message: `lane set ${setId} scaled to a ${width.toFixed(2)} m corridor (wants ${required.toFixed(2)} m)`,
      observed: Number(width.toFixed(3)), limit: Number(required.toFixed(3)),
      source: cite('default', '(lane set scaling)'),
      resolution: { id: 'shift-lateral', from: Number(required.toFixed(3)), to: Number(width.toFixed(3)) },
    });
    if (width < minRequired - 1e-6 && def.overflowLaneId) {
      issues.push({
        severity: 'info', ruleId: 'XD-02.laneWidth', discipline: 'xd',
        message: `corridor ${width.toFixed(2)} m cannot hold lane set ${setId} at minimum widths (${minRequired.toFixed(2)} m); lane ${def.overflowLaneId} drops into the crossing band`,
        observed: Number(width.toFixed(3)), limit: Number(minRequired.toFixed(3)),
        source: cite('default', '(lane overflow)'),
        resolution: { id: 'drop-band', note: def.overflowLaneId },
      });
      lanes = repack(lanes.map(l => (l.id === def.overflowLaneId ? { ...l, bandPurpose: 'crossing' } : l)), 'crossing', width);
    }
  }
  const scaledRequired = requiredWidthOf(lanes);
  // Canonical lane order: by band purpose then by id, so `LaneSet.lanes` never depends on table order.
  const sorted = [...lanes].sort((a, b) => (a.bandPurpose === b.bandPurpose ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.bandPurpose < b.bandPurpose ? -1 : 1));
  void rules;
  return {
    set: { id: setId, lanes: sorted, requiredCorridorWidth: Number(scaledRequired.toFixed(6)), overflowLaneId: def.overflowLaneId },
    issues,
  };
}

/** Centreline Z of a lane inside its resolved band. */
export function laneZ(band: ResolvedBand, laneHeight: number, vAlign: Lane['vAlign']): number {
  const h = Math.min(laneHeight, Math.max(0, band.z1 - band.z0));
  if (vAlign === 'top') return band.z1 - h / 2;
  if (vAlign === 'bottom') return band.z0 + h / 2;
  return (band.z0 + band.z1) / 2;
}

function perpOf(s: Segment2): Vec2 {
  const dx = s.b[0] - s.a[0];
  const dy = s.b[1] - s.a[1];
  const len = Math.hypot(dx, dy) || 1;
  return [-dy / len, dx / len];
}

/** Polyline for a lane at a lateral shift inside the lane (from the allocator), at height `z`. */
export function lanePathIn(centerline: readonly Segment2[], lane: Lane, z: number, lateralShift: number): Vec3[] {
  const out: Vec3[] = [];
  const lateral = lane.offset + lateralShift;
  for (let i = 0; i < centerline.length; i++) {
    const s = centerline[i];
    const n = perpOf(s);
    const a: Vec3 = [s.a[0] + n[0] * lateral, s.a[1] + n[1] * lateral, z];
    const b: Vec3 = [s.b[0] + n[0] * lateral, s.b[1] + n[1] * lateral, z];
    if (i === 0) out.push(a);
    out.push(b);
  }
  return out;
}

/** The boxes a run of section w × h along `path` occupies (axis-aligned bounds per segment). */
export function laneBoxes(path: readonly Vec3[], w: number, h: number): Box3[] {
  const out: Box3[] = [];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const x0 = Math.min(a[0], b[0]) - w / 2;
    const x1 = Math.max(a[0], b[0]) + w / 2;
    const y0 = Math.min(a[1], b[1]) - w / 2;
    const y1 = Math.max(a[1], b[1]) + w / 2;
    const z0 = Math.min(a[2], b[2]) - h / 2;
    const z1 = Math.max(a[2], b[2]) + h / 2;
    if (x1 - x0 <= TOL && y1 - y0 <= TOL) continue;
    out.push({ x: x0, y: y0, z: z0, w: x1 - x0, d: y1 - y0, h: z1 - z0 });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Allocators
// ---------------------------------------------------------------------------------------------------------------

/**
 * Lateral allocation inside one lane. The span of a system is a pure function of the lane's canonical
 * `systemOrder` (+ nominal widths) and the requested width — never of the call order — so two disciplines asking in
 * either order get the same answer, and asking twice is idempotent.
 */
export class LateralAllocator {
  readonly lane: Lane;
  private slots: Map<string, LateralSpan>;
  private extra: string[];
  private extraWidth: Map<string, number>;

  constructor(lane: Lane) {
    this.lane = lane;
    this.slots = new Map<string, LateralSpan>();
    this.extra = [];
    this.extraWidth = new Map<string, number>();
    this.rebuild();
  }

  private rebuild(): void {
    const l = this.lane;
    const declared = LANE_SYSTEMS[l.id] ?? [];
    const total = declared.reduce((s, d) => s + d.width, 0) + [...this.extraWidth.values()].reduce((s, w) => s + w, 0);
    const scale = total > l.width && total > TOL ? l.width / total : 1;
    // Inboard edge = the edge nearer the corridor centreline, so the first claimer sits closest to the centre.
    const inboardSign = l.offset >= 0 ? -1 : 1;
    const inboardEdge = l.offset + (inboardSign * l.width) / 2;
    let cursor = 0;
    const next = (w: number): LateralSpan => {
      const a = inboardEdge - inboardSign * cursor;
      const b = a - inboardSign * w;
      cursor += w;
      return { a: Math.min(a, b), b: Math.max(a, b), centre: (a + b) / 2 };
    };
    this.slots = new Map<string, LateralSpan>();
    for (const d of declared) this.slots.set(d.key, next(d.width * scale));
    for (const k of this.extra) this.slots.set(k, next((this.extraWidth.get(k) ?? 0) * scale));
  }

  /** k-th claimer by canonical system order, measured from the lane's inboard edge. Idempotent. */
  claim(systemKey: string, width: number): LateralSpan | null {
    if (!this.slots.has(systemKey)) {
      if (!this.extraWidth.has(systemKey)) {
        this.extra.push(systemKey);
        this.extraWidth.set(systemKey, Math.max(0.02, Math.min(width, this.lane.width)));
        this.rebuild();
      }
    }
    const slot = this.slots.get(systemKey);
    if (!slot) return null;
    const avail = slot.b - slot.a;
    if (avail <= TOL) return null;
    const w = Math.min(Math.max(width, 0.02), avail);
    const centre = slot.centre;
    return { a: centre - w / 2, b: centre + w / 2, centre };
  }

  used(): number {
    let sum = 0;
    for (const s of this.slots.values()) sum += s.b - s.a;
    return sum;
  }
}

/**
 * Along-corridor stations for crossings. A branch that wants the same station as an earlier one is walked outward
 * (+p, −p, +2p, −2p …) so the two never overlap — and because the shift happens **before** the element is emitted,
 * a clash is never modelled. Idempotent per key.
 */
export class StationAllocator {
  readonly bandId: string;
  readonly pitch: number;
  private taken: { a: number; b: number; key: string }[];
  private memo: Map<string, { station: number; shifted: number }>;

  constructor(bandId: string, pitch: number) {
    this.bandId = bandId;
    this.pitch = Math.max(0.05, pitch);
    this.taken = [];
    this.memo = new Map<string, { station: number; shifted: number }>();
  }

  claim(key: string, station: number, length: number): { station: number; shifted: number } | null {
    const hit = this.memo.get(key);
    if (hit) return hit;
    const half = Math.max(length, this.pitch) / 2;
    const free = (s: number): boolean => {
      for (const t of this.taken) {
        if (s - half < t.b - TOL && s + half > t.a + TOL) return false;
      }
      return true;
    };
    for (let step = 0; step <= 40; step++) {
      for (const dir of step === 0 ? [0] : [1, -1]) {
        const s = station + dir * step * this.pitch;
        if (s < 0) continue;
        if (!free(s)) continue;
        this.taken.push({ a: s - half, b: s + half, key });
        this.taken.sort((x, y) => x.a - y.a);
        const out = { station: s, shifted: s - station };
        this.memo.set(key, out);
        return out;
      }
    }
    return null;
  }

  stations(): readonly { a: number; b: number; key: string }[] {
    return this.taken;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// v1 compatibility (deleted in wave 3 with `core/coordination.ts`)
// ---------------------------------------------------------------------------------------------------------------

export interface LaneOffsetProjection {
  duct: number;
  pipe: number;
  sprinkler: number;
  tray: number;
}

/**
 * v1 `DEFAULT_LANES`. These four numbers are the frozen v1 geometry: the not-yet-migrated MEP disciplines still
 * position their runs from them, so they must not move until M1/M2 switch to `reserveLaneRun` (wave 2), at which
 * point both this constant and the shim that re-exports it are deleted.
 */
export const LANE_OFFSETS_V1: Readonly<LaneOffsetProjection> = { duct: 0, pipe: -0.35, sprinkler: -0.15, tray: 0.35 };

/** The v2 lane table projected onto the four v1 names (what `DEFAULT_LANES` becomes once MEP is on the kernel). */
export function laneOffsetProjection(profileId: ProfileId = 'resi-corridor', corridorWidth = 0, rules?: RuleSet): LaneOffsetProjection {
  const setId = laneSetIdFor(profileId);
  const lanes = setId ? LANE_SETS[setId].lanes : [];
  const scale = (() => {
    if (corridorWidth <= TOL) return 1;
    const req = requiredWidthOf(lanes);
    return corridorWidth < req ? Math.max(0.1, corridorWidth / req) : 1;
  })();
  const off = (id: string, fallback: number): number => {
    const l = lanes.find(x => x.id === id);
    return l ? Number((l.offset * scale).toFixed(4)) : fallback;
  };
  void rules;
  return {
    duct: off('duct', LANE_OFFSETS_V1.duct),
    pipe: off('pressure', LANE_OFFSETS_V1.pipe),
    sprinkler: off('sprinkler', LANE_OFFSETS_V1.sprinkler),
    tray: off('tray-power', LANE_OFFSETS_V1.tray),
  };
}
