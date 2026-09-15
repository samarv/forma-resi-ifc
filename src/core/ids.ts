/**
 * Deterministic id scheme. Ids are stable for a given spec so that diffs between
 * generations are meaningful and downstream disciplines can reference upstream objects.
 *
 *   <DISC>-<STOREY>-<KIND>-<NNN>        e.g. ARC-L03-WALL-017, STR-L01-COL-004, PLB-L02-PIPE-031
 *   U-<STOREY>-<NN>                      dwelling unit          U-L03-04
 *   R-<UNITID or STOREY>-<ROOMTYPE><N>   room                   R-U-L03-04-BED1, R-L01-LOBBY1
 *   SYS-<DISC>-<NAME>                    MEP system             SYS-PLB-DCW
 */
import type { Discipline } from './types.ts';

const DISC_PREFIX: Record<Discipline, string> = {
  site: 'SIT',
  architecture: 'ARC',
  structure: 'STR',
  mechanical: 'MEC',
  plumbing: 'PLB',
  electrical: 'ELE',
};

export class IdFactory {
  private counters = new Map<string, number>();
  private readonly discipline: Discipline;

  constructor(discipline: Discipline) {
    this.discipline = discipline;
  }

  /** Next id for a kind within a storey, zero-padded */
  next(storey: string, kind: string): string {
    const key = `${storey}:${kind}`;
    const n = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, n);
    return `${DISC_PREFIX[this.discipline]}-${storey}-${kind}-${String(n).padStart(3, '0')}`;
  }

  /** Free-form id under this discipline's prefix */
  named(...parts: (string | number)[]): string {
    return [DISC_PREFIX[this.discipline], ...parts].join('-');
  }
}

export function disciplinePrefix(d: Discipline): string {
  return DISC_PREFIX[d];
}

export function unitId(storey: string, n: number): string {
  return `U-${storey}-${String(n).padStart(2, '0')}`;
}

export function roomId(owner: string, roomType: string, n: number): string {
  return `R-${owner}-${roomType.toUpperCase().replace(/[^A-Z0-9]/g, '')}${n}`;
}

export function systemId(discipline: Discipline, name: string): string {
  return `SYS-${DISC_PREFIX[discipline]}-${name.toUpperCase().replace(/[^A-Z0-9]/g, '-')}`;
}

/** Storey id helpers */
export function storeyIdFor(index: number): string {
  if (index < 0) return `B${-index}`;
  return `L${String(index + 1).padStart(2, '0')}`;
}
export const SITE_STOREY = 'SITE';
export const FOUNDATION_STOREY = 'FND';
export const ROOF_STOREY = 'ROOF';
