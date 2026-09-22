/**
 * Port resolution: module-local ports → world XY on the slot boundary (design §4.6 phase 4).
 *
 * 'front' is the access side and u runs along it, so mirroring maps `atFrac → 1 − atFrac` on the frontage sides and
 * swaps the two end sides. Every instance of a module therefore lands its stack at the same fraction of the same
 * side: vertical alignment is a property of the MODULE, not a coordinate the organiser has to remember and re-impose
 * (which is what `UnitSlot.stackAlong` used to do, and what "requested stack position u=… sits in the kitchen" used
 * to report when the imposed coordinate and the plan disagreed).
 */
import type { Rect, Side, Vec2 } from '../../../core/types.ts';
import type { ModuleCatalogue, Port } from '../../../modules/types.ts';
import type { ResolvedPort, Slot } from './types.ts';
import { oppositeSide, round } from '../../../core/geometry.ts';

/** The two sides of a slot perpendicular to its access side — where an end-of-bar module's ports live */
export function endSidesOf(accessSide: Side): [Side, Side] {
  return accessSide === 'front' || accessSide === 'rear' ? ['left', 'right'] : ['front', 'rear'];
}

export function resolvePorts(ports: readonly Port[], slot: Slot): ResolvedPort[] {
  const out: ResolvedPort[] = [];
  const access = slot.accessSide;
  const opposite = oppositeSide(access);
  const ends = endSidesOf(access);
  const r = slot.boundary;
  const horizontal = access === 'front' || access === 'rear';
  const frontageLen = horizontal ? r.w : r.h;
  const depthLen = horizontal ? r.h : r.w;

  for (const p of ports) {
    let side: Side;
    let frac = p.atFrac;
    if (p.side === 'front' || p.side === 'interior') side = access;
    else if (p.side === 'rear') side = opposite;
    else if (p.side === 'left') side = slot.mirrored ? ends[1] : ends[0];
    else side = slot.mirrored ? ends[0] : ends[1];
    const onFrontage = side === access || side === opposite;
    if (onFrontage && slot.mirrored) frac = 1 - frac;

    const xy = pointOnSide(r, side, frac);
    out.push({
      ...p,
      atFrac: round(frac, 4),
      xy: [round(xy[0], 4), round(xy[1], 4)],
      along: round(horizontal ? xy[0] : xy[1], 4),
      wallSide: side,
      width: Math.min(p.width, onFrontage ? frontageLen : depthLen),
    });
  }
  return out;
}

/** The slot's ports re-resolved from its current module and boundary — what `applyOverrides` calls after an edit */
export function resolvePortsForSlot(slot: Slot, catalogue: ModuleCatalogue): ResolvedPort[] {
  const mod = catalogue.byId(slot.moduleId);
  if (!mod) return [];
  return resolvePorts(mod.ports, slot);
}

export function pointOnSide(r: Rect, side: Side, frac: number): Vec2 {
  const t = Math.max(0, Math.min(1, frac));
  switch (side) {
    case 'front': return [r.x + r.w * t, r.y];
    case 'rear': return [r.x + r.w * t, r.y + r.h];
    case 'left': return [r.x, r.y + r.h * t];
    default: return [r.x + r.w, r.y + r.h * t];
  }
}

/**
 * Vertical alignment check (deviation ARC-D05): two slots that carry the same module, mirroring and frontage must
 * resolve their stack ports to the same fraction. It is an assertion on the port mechanism, not a repair.
 */
export function portAlignment(slots: readonly Slot[]): { key: string; fracs: number[] }[] {
  const byKey = new Map<string, Set<number>>();
  for (const s of slots) {
    if (s.kind !== 'unit') continue;
    const stack = s.ports.find(p => p.kind === 'stack');
    if (!stack) continue;
    const horizontal = s.accessSide === 'front' || s.accessSide === 'rear';
    const frontage = Math.round((horizontal ? s.boundary.w : s.boundary.h) * 100);
    const key = `${s.moduleId}|${s.mirrored ? 'm' : '-'}|${frontage}`;
    const set = byKey.get(key) ?? new Set<number>();
    set.add(Math.round(stack.atFrac * 1000));
    byKey.set(key, set);
  }
  const bad: { key: string; fracs: number[] }[] = [];
  for (const [key, set] of [...byKey.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (set.size > 1) bad.push({ key, fracs: [...set].sort((a, b) => a - b).map(v => v / 1000) });
  }
  return bad;
}
