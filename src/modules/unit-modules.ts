/**
 * Unit modules: template × variant, one frozen `PlanShape` each, elastic frontage/depth ranges DERIVED from the
 * program (never declared by hand). 45 records — `mirrored` is a slot property, so a mirrored module is not a second
 * record, and the plan type is module identity rather than a runtime guess.
 *
 *   micro-studio · studio · junior-1b · 1b1b · 1b-den · senior-1b-accessible · loft-live-work   single, end
 *   2b1b · 2b2b · 3b2b · 4b2b                                                    single, dual, corner, end
 *   corner-2b2b  corner · dual-key  dual-key · coliving-cluster  cluster · maisonette-2s  dual, end
 *   townhouse-2s · townhouse-3s · ranch-3b · colonial-4b · adu-1b                        end, corner
 *
 * `single` = access + one opposite façade. `dual` = access + opposite + a short end façade. `corner` = two
 * perpendicular façades. `end` = end of bar, three façades. `cluster` / `dual-key` carry their own shapes.
 */
import type { Region, Side, UnitTemplateDef, UnitTemplateId } from '../core/types.ts';
import type { FeasibilityOpts, PlanShape, ProgramGraph, Range } from '../disciplines/architecture/program/types.ts';
import type { Port, UnitModule, UnitVariant } from './types.ts';
import { UNIT_TEMPLATES } from '../disciplines/architecture/templates.ts';
import { unitModuleId } from './ids.ts';
import { planShapesFor, programFor } from './program-source.ts';

/** The variant table of the design doc §2.3 */
export const VARIANT_TABLE: Record<UnitTemplateId, UnitVariant[]> = {
  'micro-studio': ['single', 'end'],
  studio: ['single', 'end'],
  'junior-1b': ['single', 'end'],
  '1b1b': ['single', 'end'],
  '1b-den': ['single', 'end'],
  'senior-1b-accessible': ['single', 'end'],
  'loft-live-work': ['single', 'end'],
  '2b1b': ['single', 'dual', 'corner', 'end'],
  '2b2b': ['single', 'dual', 'corner', 'end'],
  '3b2b': ['single', 'dual', 'corner', 'end'],
  '4b2b': ['single', 'dual', 'corner', 'end'],
  'corner-2b2b': ['corner'],
  'dual-key': ['dual-key'],
  'coliving-cluster': ['cluster'],
  'maisonette-2s': ['dual', 'end'],
  'townhouse-2s': ['end', 'corner'],
  'townhouse-3s': ['end', 'corner'],
  'ranch-3b': ['end', 'corner'],
  'colonial-4b': ['end', 'corner'],
  'adu-1b': ['end', 'corner'],
};

export interface VariantNeeds { exteriorSides: Side[]; minExteriorCount: number; endOfBar: boolean }

export function needsFor(variant: UnitVariant): VariantNeeds {
  switch (variant) {
    case 'single': return { exteriorSides: [], minExteriorCount: 1, endOfBar: false };
    case 'dual': return { exteriorSides: [], minExteriorCount: 2, endOfBar: false };
    case 'corner': return { exteriorSides: [], minExteriorCount: 2, endOfBar: false };
    case 'end': return { exteriorSides: [], minExteriorCount: 2, endOfBar: true };
    // A co-living cluster is a DEEP single-aspect plan (ARC-12): its own corridor runs from the access side to the
    // far façade, so one exterior face is what it needs — the same face every other unit on that strip gets.
    case 'cluster': return { exteriorSides: [], minExteriorCount: 1, endOfBar: false };
    default: return { exteriorSides: [], minExteriorCount: 1, endOfBar: false };
  }
}

export function variantName(variant: UnitVariant): string {
  switch (variant) {
    case 'single': return 'single aspect';
    case 'dual': return 'dual aspect';
    case 'corner': return 'corner';
    case 'end': return 'end of bar';
    case 'cluster': return 'cluster';
    default: return 'dual key';
  }
}

/**
 * The candidate shapes of a module, one list per level. `planShapesFor` is preference-ordered, so `[0]` is the plan
 * the solver will reach for; the record freezes that one as the module's identity and the editor draws it.
 */
export function shapesOf(g: ProgramGraph, variant: UnitVariant, o: FeasibilityOpts): PlanShape[] {
  const out: PlanShape[] = [];
  for (let l = 0; l < g.levels; l++) {
    const shapes = planShapesFor(g, { ...o, levels: l });
    // a variant names the FAÇADE situation the placer must give the module (see `needsFor`); the plan type that
    // situation prefers is the solver's call, which is why `planShapesFor` has no variant argument
    const want: PlanShape['type'] | null = variant === 'cluster' ? 'cluster'
      : variant === 'dual-key' ? 'dual-key'
        : variant === 'single' ? 'zoned' : null;
    const pick = (want ? shapes.find(sh => sh.type === want) : undefined) ?? shapes[0];
    if (pick) out.push(pick);
  }
  return out;
}

/**
 * The (frontage, depth) envelope: the solver's admissible depth band, with the frontage hull over it. Only the
 * FIRST-PASS filter — `catalogue.frontageAt` is the exact test at a concrete depth.
 */
export function envelopeOf(t: UnitTemplateDef): { frontage: Range; depth: Range } {
  /*
   * DECLARATIVE, and deliberately generous. The frozen contract calls this "the envelope of the admissible region —
   * the first-pass filter; the exact test is catalogue.frontageAt", and that is exactly how the packer uses it:
   * `candidatesFor` screens on the envelope, then every candidate is re-checked with `frontageAt(id, netDepth)`.
   *
   * Deriving it from the solver instead would cost a depth sweep per graph (~90 ms each, 1.8 s for the catalogue)
   * to compute a bound that is then never trusted — so it comes from the type's own declared bands, widened by the
   * slack the solver is allowed to find. The catalogue builds in ~5 ms and the 120 ms budget (design §9) is met with
   * room to spare.
   */
  const levels = Math.max(1, t.storeysInUnit);
  const depth: Range = { min: round3(Math.max(4, t.depth.min - 1.0)), max: round3(t.depth.max + 1.5) };
  const byArea = { lo: t.area.min / levels / depth.max, hi: t.area.max / levels / depth.min };
  return {
    frontage: {
      min: round3(Math.max(2.4, Math.min(t.frontage.min, byArea.lo) * 0.8)),
      // The upper bound is TYPE IDENTITY, and `catalogue.frontageAt` intersects the solver's answer with it: the
      // solver will happily tell you a 2b2b on a 7.65 m deep bar has to be 16 m wide, and a 122 m² two-bed is not
      // a two-bed. Intersecting turns that into "no 2b2b at this depth", which is the honest answer.
      max: round3(Math.max(t.frontage.max, byArea.hi) * 1.15),
    },
    depth,
  };
}

/**
 * Ports as FRACTIONS of frontage, computed from the frozen shape's minimum column widths — so every instance of a
 * module produces the same `atFrac` and identical modules stack vertically by construction.
 */
export function portsFor(g: ProgramGraph, shape: PlanShape, variant: UnitVariant, frontage: Range): Port[] {
  const byRef = new Map(g.nodes.map(n => [n.ref, n] as const));
  const ports: Port[] = [];
  const spineW = shape.spine ? shape.spine.width.min : 0;

  // ---- the access band's column fractions --------------------------------------------------
  const front = shape.bands.find(b => !b.daylit) ?? shape.bands[0];
  const cols = front ? front.columns : [];
  const wid = cols.map(c => Math.max(...c.map(r => byRef.get(r)?.minWidth ?? 0.6)));
  const total = wid.reduce((a, c) => a + c, 0) + spineW;
  const fracOf = (i: number): number => {
    if (total <= 1e-6) return 0.5;
    let acc = spineW;
    for (let k = 0; k < i; k++) acc += wid[k];
    return clamp01((acc + wid[i] / 2) / total);
  };

  // entry: next to the circulation column when there is one, otherwise the middle of the access side
  let entryFrac = 0.5;
  for (let i = 0; i < cols.length; i++) {
    if (cols[i].some(r => byRef.get(r)?.zone === 'circulation')) { entryFrac = fracOf(i); break; }
  }
  if (shape.spine && total > 1e-6) entryFrac = clamp01(spineW / 2 / total);
  ports.push({ id: 'entry', kind: 'entry', side: 'front', atFrac: round3(entryFrac), width: 0.9, required: true });

  // stack: the wet column of the access band (XD-01 — one wet wall per unit, two for a 2-bath program)
  const wetCols: number[] = [];
  for (let i = 0; i < cols.length; i++) if (cols[i].some(r => byRef.get(r)?.wet)) wetCols.push(i);
  if (wetCols.length === 0) wetCols.push(Math.max(0, Math.floor(cols.length / 2)));
  const maxStacks = g.maxStacks;
  const stacks = wetCols.slice(0, maxStacks);
  for (let k = 0; k < stacks.length; k++) {
    ports.push({
      id: `stack.${k + 1}`, kind: 'stack', side: 'front', atFrac: round3(fracOf(stacks[k])),
      width: 0, purpose: 'plumbing', required: k === 0,
    });
  }
  // exhaust: kitchen and bath extract terminate on the access side, beside their stack
  ports.push({
    id: 'exhaust.1', kind: 'exhaust', side: 'front', atFrac: round3(fracOf(stacks[0])), width: 0, required: false,
  });
  // panel: inside the entry/circulation column
  ports.push({ id: 'panel', kind: 'panel', side: 'front', atFrac: round3(entryFrac), width: 0, required: false });

  // daylight: the glazable façade opposite the access
  const back = shape.bands.find(b => b.daylit);
  if (back) {
    // the glazable length is the SLOT's own side length; the port declares the minimum it needs and
    // `resolvePorts` clamps it to what the slot actually has
    ports.push({ id: 'daylight.rear', kind: 'daylight', side: 'rear', atFrac: 0.5, width: 1.2, required: true });
  }
  // balcony: opposite the access, centred
  ports.push({ id: 'balcony', kind: 'balcony', side: 'rear', atFrac: 0.5, width: 1.6, required: false });
  // a module wider than the widest structural bay needs an interior column line of its own
  if (frontage.max > 9.0) {
    ports.push({ id: 'party-line.mid', kind: 'party-line', side: 'interior', atFrac: 0.5, width: 0, required: false });
  }
  if (variant === 'end' || variant === 'corner') {
    ports.push({ id: 'daylight.end', kind: 'daylight', side: 'right', atFrac: 0.5, width: 1.2, required: false });
  }
  return ports;
}

function clamp01(v: number): number {
  return Math.max(0.02, Math.min(0.98, v));
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Build every unit module admissible for `region`. Deterministic: template order × variant order. */
export function buildUnitModules(region: Region, rulesHash: string): UnitModule[] {
  const out: UnitModule[] = [];
  for (const templateId of Object.keys(UNIT_TEMPLATES) as UnitTemplateId[]) {
    const t = UNIT_TEMPLATES[templateId];
    const g = programFor(templateId);
    for (const variant of VARIANT_TABLE[templateId] ?? []) {
      const o: FeasibilityOpts = {
        region,
        accessible: templateId === 'senior-1b-accessible',
        detail: 'medium',
        rulesHash,
      };
      const shapes = shapesOf(g, variant, o);
      if (shapes.length === 0) continue;
      const env = envelopeOf(t);
      out.push({
        id: unitModuleId(templateId, variant),
        kind: 'unit',
        name: `${t.name} (${variantName(variant)})`,
        frontage: env.frontage,
        depth: env.depth,
        ports: portsFor(g, shapes[0], variant, env.frontage),
        mirrorable: true,
        patterns: [...t.patterns],
        templateId,
        variant,
        programId: g.id,
        shape: shapes[0],
        levels: t.storeysInUnit,
        areaTarget: t.area.target,
        bedrooms: t.bedrooms,
        bathrooms: t.bathrooms,
        occupants: t.occupants,
        needs: needsFor(variant),
      });
    }
  }
  return out;
}
