/**
 * Orchestration: spec → site/massing → architecture → structure → mechanical → plumbing → electrical
 * → merged element list → metrics → pattern trace. Pure; no IO. The IFC writer is separate (src/ifc/writer.ts).
 */
import type { BuildingSpec, DesignModel, GenContext, ModelElement, PatternApplication } from './core/types.ts';
import { normalizeSpec, buildStoreys, type PartialSpec } from './core/spec.ts';
import { getTypology } from './core/typologies.ts';
import { createRng } from './core/rng.ts';
import { PatternBook, CROSS_PATTERNS } from './core/patterns.ts';

import { generateSite, SITE_PATTERNS } from './disciplines/site/index.ts';
import { generateArchitecture, ARCH_PATTERNS } from './disciplines/architecture/index.ts';
import { generateStructure, STRUCT_PATTERNS } from './disciplines/structure/index.ts';
import { generateMechanical, MECH_PATTERNS } from './disciplines/mechanical/index.ts';
import { generatePlumbing, PLUMB_PATTERNS } from './disciplines/plumbing/index.ts';
import { generateElectrical, ELEC_PATTERNS } from './disciplines/electrical/index.ts';
import { computeMetrics } from './core/metrics.ts';

export function generateBuilding(input: PartialSpec | BuildingSpec): DesignModel {
  const spec: BuildingSpec = isFullSpec(input) ? input : normalizeSpec(input);
  const typology = getTypology(spec.typology);
  const rng = createRng(spec.seed);
  const warnings: string[] = [];
  const timings: Record<string, number> = {};
  const book = new PatternBook();
  book.register(...CROSS_PATTERNS, ...SITE_PATTERNS, ...ARCH_PATTERNS, ...STRUCT_PATTERNS, ...MECH_PATTERNS, ...PLUMB_PATTERNS, ...ELEC_PATTERNS);

  const t0 = now();
  const site = generateSite(spec, typology, rng.fork('site'), warnings);
  timings.site = now() - t0;

  const storeys = site.massing.storeys.length > 0 ? site.massing.storeys : buildStoreys(spec, spec.floors);

  const ctx: GenContext = { spec, typology, rng, storeys, site, arch: null, struct: null, mech: null, plumb: null, elec: null, warnings };

  const t1 = now();
  ctx.arch = generateArchitecture({ ...ctx, rng: rng.fork('architecture') });
  timings.architecture = now() - t1;

  if (spec.options.structure) {
    const t = now();
    ctx.struct = generateStructure({ ...ctx, rng: rng.fork('structure') });
    timings.structure = now() - t;
  }
  if (spec.options.mechanical) {
    const t = now();
    ctx.mech = generateMechanical({ ...ctx, rng: rng.fork('mechanical') });
    timings.mechanical = now() - t;
  }
  if (spec.options.plumbing) {
    const t = now();
    ctx.plumb = generatePlumbing({ ...ctx, rng: rng.fork('plumbing') });
    timings.plumbing = now() - t;
  }
  if (spec.options.electrical) {
    const t = now();
    ctx.elec = generateElectrical({ ...ctx, rng: rng.fork('electrical') });
    timings.electrical = now() - t;
  }

  const elements: ModelElement[] = [
    ...(spec.options.site ? site.elements : []),
    ...ctx.arch.elements,
    ...(ctx.struct?.elements ?? []),
    ...(ctx.mech?.elements ?? []),
    ...(ctx.plumb?.elements ?? []),
    ...(ctx.elec?.elements ?? []),
  ];
  assertUniqueIds(elements, warnings);

  const applications: PatternApplication[] = [
    ...site.patterns,
    ...ctx.arch.patterns,
    ...(ctx.struct?.patterns ?? []),
    ...(ctx.mech?.patterns ?? []),
    ...(ctx.plumb?.patterns ?? []),
    ...(ctx.elec?.patterns ?? []),
  ];
  for (const a of applications) {
    if (!book.get(a.patternId)) warnings.push(`Pattern application references unknown pattern ${a.patternId}`);
    else book.apply(a);
  }

  const model: DesignModel = {
    spec,
    typology,
    storeys,
    site,
    arch: ctx.arch,
    struct: ctx.struct,
    mech: ctx.mech,
    plumb: ctx.plumb,
    elec: ctx.elec,
    elements,
    metrics: [],
    patterns: { book: book.all(), applications: book.trace() },
    warnings,
    timings,
  };
  const t2 = now();
  model.metrics = computeMetrics(model);
  timings.metrics = now() - t2;
  return model;
}

function isFullSpec(s: PartialSpec | BuildingSpec): s is BuildingSpec {
  return typeof (s as BuildingSpec).seed === 'number' && !!(s as BuildingSpec).options && !!(s as BuildingSpec).site && typeof (s as BuildingSpec).site.width === 'number' && Array.isArray((s as BuildingSpec).floors) && (s as BuildingSpec).floors.length > 0;
}

function assertUniqueIds(elements: ModelElement[], warnings: string[]): void {
  const seen = new Set<string>();
  for (const e of elements) {
    if (seen.has(e.id)) warnings.push(`Duplicate element id ${e.id}`);
    seen.add(e.id);
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
