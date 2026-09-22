/**
 * The ONE seam between `program/` and the furniture-kit library (`program/kits.ts`).
 *
 * Everything under `program/` reads kit minima and kit mandatory-item sets through this module, so the
 * program solver depends on the kit CONTRACT rather than on the kit implementation. It carried a local
 * copy of the minima table while `kits.ts` was still being written; now it re-exports, and the
 * build-time assertion in `feasibility.test.ts` re-checks that every `ProgramNode` still clears
 * `kitMinDims(node.kit)` in both dimensions.
 *
 * `fitKit` here is the *predicate* (`kits.ts` calls it `kitFits`): does the complete kit fit this rect
 * with these door-swing keep-outs reserved? The full placement engine — the offset sweep and the
 * two-wall fallback — is `kits.ts`'s own `fitKit(args)`, which the furnishing pass calls.
 */
/** Minimum clear room dimensions a kit needs (m) */
export interface KitDims { w: number; d: number }
export {
  BASIN_ITEMS,
  BATHING_ITEMS,
  KIT_IDS,
  kitFits as fitKit,
  kitMandatory,
  kitMinDims,
  kitOneOf,
  type KitFit,
} from './kits.ts';
