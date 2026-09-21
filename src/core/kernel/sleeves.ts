/**
 * Sleeves — every penetration of a rated wall or a slab is a sleeve with a firestop, never a hole.
 *
 * A sleeve is the only legal way through a slab or a non-structural wall in this model; beams, columns and hoistways
 * are keep-outs (`CLEARANCES`: "no designed openings"), so a penetration request against them is a conflict rather
 * than a sleeve.
 */
import type { Ledger, RuleSet } from '../rules/types.ts';
import { cite } from '../rules/SOURCES.ts';
import type { Box3, Conflict, ReserveRequest, ReserveResult, Sleeve, SleeveRequest } from './types.ts';
import { isConflict } from './types.ts';
import { kindOfSystem } from './shafts.ts';

/** Annulus kept all round the pipe for the firestop material. */
export const SLEEVE_ANNULUS = 0.025;
export const SLEEVE_ANNULUS_SOURCE = cite('IBC 2021', '§714.5 (through-penetration firestop system)');

/** Nominal sleeve sizes (m) — a sleeve is rounded UP to one of these. */
export const SLEEVE_NOMINALS: readonly number[] = [0.05, 0.075, 0.1, 0.125, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6];

export const DEFAULT_RATING_SLAB = '2 h';
export const DEFAULT_RATING_WALL = '1 h';

export interface SleeveAllocatorOptions {
  rules: RuleSet;
  ledger: Ledger;
  reserve(req: ReserveRequest): ReserveResult;
}

export interface SleeveAllocator {
  sleeve(req: SleeveRequest): Sleeve | Conflict;
  all(): readonly Sleeve[];
}

export function nominalSleeve(outsideDiameter: number): number {
  const wanted = outsideDiameter + 2 * SLEEVE_ANNULUS;
  for (const n of SLEEVE_NOMINALS) if (n >= wanted - 1e-9) return n;
  return Math.ceil(wanted * 20) / 20;
}

export function firestopFor(rating: string, hostKind: 'wall' | 'slab', outsideDiameter: number): string {
  const kind = outsideDiameter <= 0.05 ? 'intumescent wrap + sealant' : 'intumescent collar + sealant';
  return `${kind}, ${(SLEEVE_ANNULUS * 1000).toFixed(0)} mm annulus, ${rating} ${hostKind} penetration (ASTM E814 / UL 1479 tested assembly)`;
}

export function createSleeveAllocator(o: SleeveAllocatorOptions): SleeveAllocator {
  const sleeves: Sleeve[] = [];
  const memo = new Map<string, Sleeve>();
  let n = 0;

  return {
    sleeve(req: SleeveRequest): Sleeve | Conflict {
      const key = `${req.storey}|${req.hostId}|${req.system}|${req.at[0].toFixed(3)}|${req.at[1].toFixed(3)}|${req.z.toFixed(3)}`;
      const prev = memo.get(key);
      if (prev) return prev;

      const rating = req.rating ?? (req.hostKind === 'slab' ? DEFAULT_RATING_SLAB : DEFAULT_RATING_WALL);
      const sleeveDiameter = nominalSleeve(req.outsideDiameter);
      const box: Box3 = {
        x: req.at[0] - sleeveDiameter / 2,
        y: req.at[1] - sleeveDiameter / 2,
        z: req.z,
        w: sleeveDiameter,
        d: sleeveDiameter,
        h: Math.max(0.05, sleeveDiameter),
      };
      const res = o.reserve({
        owner: 'plumbing',
        kind: kindOfSystem(req.system),
        storey: req.storey,
        container: req.hostKind === 'slab' ? 'floor' : 'wall',
        containerId: req.hostId,
        boxes: [box],
        note: `sleeve for ${req.system} through ${req.hostKind} ${req.hostId}`,
      });
      if (isConflict(res)) return res;

      n += 1;
      const sleeve: Sleeve = {
        id: `SLV-${String(n).padStart(4, '0')}`,
        storey: req.storey,
        hostKind: req.hostKind,
        hostId: req.hostId,
        xy: req.at,
        z: req.z,
        outsideDiameter: req.outsideDiameter,
        sleeveDiameter,
        rating,
        firestop: firestopFor(rating, req.hostKind, req.outsideDiameter),
        reservationId: res.id,
      };
      memo.set(key, sleeve);
      sleeves.push(sleeve);
      return sleeve;
    },

    all(): readonly Sleeve[] {
      return sleeves;
    },
  };
}
