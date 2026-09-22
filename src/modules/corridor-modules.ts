/**
 * Corridor segments and BREAK modules. A break is what resets the ARC-03 leg counter: the placer reserves the site
 * graph's break slots BEFORE it packs units, then instantiates one of these into each slot, so "corridor runs 71.7 m
 * without a break" cannot be reported — the run is cut by construction.
 *
 *   K-lounge       a widened seating bay on the corridor                     resets the leg
 *   K-lift-lobby   the widened lobby in front of a lift bank                 resets the leg
 *   K-window-bay   a daylit bay at a façade (needs an exterior face)         resets the leg
 *   K-cross        a cross-corridor link between two bars                    resets the leg, joins the graph
 *   K-exit-stair   a secondary exit stair dropped into the corridor          resets the leg AND counts as an exit
 */
import type { BreakModule, BreakRole, CorridorModule, Port } from './types.ts';
import { breakModuleId, corridorModuleId } from './ids.ts';

/** Corridor clear widths the generator can produce (IBC 1020.2 min 1.12 m; senior-living 2.0 m) */
export const CORRIDOR_WIDTHS = [1.2, 1.5, 1.6, 1.8, 2.0, 2.4];

export function buildCorridorModules(): CorridorModule[] {
  return CORRIDOR_WIDTHS.map(w => ({
    id: corridorModuleId(w),
    kind: 'corridor' as const,
    name: `Corridor ${w.toFixed(2)} m clear`,
    frontage: { min: 1.2, max: 200 },
    depth: { min: w, max: w },
    ports: [
      { id: 'a', kind: 'corridor-connect', side: 'left', atFrac: 0.5, width: w, required: true },
      { id: 'b', kind: 'corridor-connect', side: 'right', atFrac: 0.5, width: w, required: true },
    ] as Port[],
    mirrorable: false,
    patterns: ['ARC-03', 'XD-02'],
    width: w,
  }));
}

interface BreakSpec {
  role: BreakRole;
  name: string;
  frontage: { min: number; max: number };
  depth: { min: number; max: number };
  resetsLeg: boolean;
  isExit: boolean;
  needsFacade: boolean;
  roomType: 'lounge' | 'lift-lobby' | 'corridor' | 'stair';
}

const BREAKS: BreakSpec[] = [
  { role: 'lounge', name: 'Corridor lounge', frontage: { min: 3.0, max: 8.0 }, depth: { min: 2.4, max: 9.0 }, resetsLeg: true, isExit: false, needsFacade: false, roomType: 'lounge' },
  { role: 'lift-lobby', name: 'Lift lobby break', frontage: { min: 3.0, max: 6.5 }, depth: { min: 2.4, max: 9.0 }, resetsLeg: true, isExit: false, needsFacade: false, roomType: 'lift-lobby' },
  { role: 'window-bay', name: 'Daylit window bay', frontage: { min: 2.4, max: 5.0 }, depth: { min: 1.8, max: 6.0 }, resetsLeg: true, isExit: false, needsFacade: true, roomType: 'lounge' },
  { role: 'cross-corridor', name: 'Cross corridor', frontage: { min: 1.8, max: 3.2 }, depth: { min: 1.8, max: 12.0 }, resetsLeg: true, isExit: false, needsFacade: false, roomType: 'corridor' },
  { role: 'exit-stair', name: 'Secondary exit stair', frontage: { min: 3.0, max: 5.6 }, depth: { min: 3.0, max: 7.0 }, resetsLeg: true, isExit: true, needsFacade: false, roomType: 'stair' },
];

export const BREAK_ROOM_TYPE: Record<BreakRole, BreakSpec['roomType']> =
  BREAKS.reduce((m, b) => { m[b.role] = b.roomType; return m; }, {} as Record<BreakRole, BreakSpec['roomType']>);

export function buildBreakModules(): BreakModule[] {
  return BREAKS.map(b => ({
    id: breakModuleId(b.role),
    kind: 'break' as const,
    name: b.name,
    frontage: b.frontage,
    depth: b.depth,
    ports: [
      { id: 'corridor.a', kind: 'corridor-connect', side: 'left', atFrac: 0.5, width: 1.2, required: true },
      { id: 'corridor.b', kind: 'corridor-connect', side: 'right', atFrac: 0.5, width: 1.2, required: b.role === 'cross-corridor' },
      ...(b.needsFacade
        ? [{ id: 'daylight', kind: 'daylight' as const, side: 'rear' as const, atFrac: 0.5, width: 1.5, required: true }]
        : []),
      ...(b.isExit
        ? [{ id: 'exit', kind: 'exit' as const, side: 'front' as const, atFrac: 0.5, width: 0.95, required: true }]
        : []),
    ] as Port[],
    mirrorable: true,
    patterns: b.isExit ? ['ARC-03', 'ARC-33'] : ['ARC-03'],
    role: b.role,
    resetsLeg: b.resetsLeg,
    isExit: b.isExit,
    needsFacade: b.needsFacade,
  }));
}

/**
 * The break the site graph asked for, in the design's preference order: a daylit end wants a window bay, a core side
 * wants a lift lobby, mid-run wants a lounge, a dead end wants an exit stair.
 */
export function breakForWant(
  breaks: readonly BreakModule[], want: 'core' | 'lounge' | 'window-bay' | 'knuckle', hasFacade: boolean,
): BreakModule | undefined {
  const order: BreakRole[] = want === 'core'
    ? ['exit-stair', 'lift-lobby', 'lounge']
    : want === 'window-bay'
      ? (hasFacade ? ['window-bay', 'lounge', 'lift-lobby'] : ['lounge', 'lift-lobby'])
      : want === 'knuckle'
        ? ['cross-corridor', 'lounge']
        : ['lounge', 'lift-lobby', 'window-bay'];
  for (const role of order) {
    const hit = breaks.find(b => b.role === role && (!b.needsFacade || hasFacade));
    if (hit) return hit;
  }
  return breaks[0];
}
