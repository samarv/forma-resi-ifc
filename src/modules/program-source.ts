/**
 * THE ONE SEAM to the program solver (`src/disciplines/architecture/program/`).
 *
 * Everything in `src/modules/**` and `src/disciplines/architecture/placer/**` reads the program layer through this
 * file, so the stub-then-swap happened here and nowhere else: until `program/programs.ts` + `program/feasibility.ts`
 * landed this module DERIVED the twenty program graphs and their feasibility from `UNIT_TEMPLATES`; it now delegates
 * to the real ones. The catalogue, the packer, the picker and the self-test are unchanged by the swap.
 *
 * What the module layer needs, and who owns it:
 *   programFor(templateId)      program/programs.ts      the 20 hand-written graphs
 *   planShapesFor(g, opts)      program/feasibility.ts   candidate plan shapes for a level, preference-ordered
 *   frontageAt(g, D, opts)      program/feasibility.ts   THE depth filter: admissible frontage, or null
 *   fitFor(g, F, D, opts)       program/feasibility.ts   the witness — the only way to obtain a layout
 *   admissibleDepths(g, opts)   program/feasibility.ts   the depth band, for a module's first-pass envelope
 *   allocate(total, items)      program/feasibility.ts   the ONE width/depth allocator
 *   kitMinDims(kit)             program/kits-api.ts      kit-derived room minima, for the self-test
 */
export { PROGRAMS, nodesAtLevel, programById, programFor, rulesFor } from '../disciplines/architecture/program/programs.ts';
export {
  DEFAULT_OPTS, admissibleDepths, allocate, feasibleAt, feasibleShape, fitFor, frontageAt, planShapesFor, refsOf,
} from '../disciplines/architecture/program/feasibility.ts';
export { kitMinDims } from '../disciplines/architecture/program/kits-api.ts';

import type { FeasibilityOpts } from '../disciplines/architecture/program/types.ts';

/** Memo key for anything derived from a feasibility query. Carries every field the solver reads. */
export function optsHash(o: FeasibilityOpts): string {
  return `${o.region}|${o.accessible ? 'a' : '-'}|${o.levels ?? 0}|${o.detail ?? 'medium'}|${o.rulesHash ?? 'v1'}`;
}
