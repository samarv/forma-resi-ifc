/**
 * Orchestration: spec → rules + issues → site/massing → structural pre-sizing → architecture → coordination kernel
 * → structure → mechanical → plumbing → electrical → merged element list → validation (kernel, support, rules)
 * → metrics → pattern trace. Pure; no IO. The IFC writer is separate (src/ifc/writer.ts).
 *
 * Two things happen before any discipline runs, because everything else depends on them:
 *   1. the RULE SET is resolved (built-ins + every pattern parameter + rule profiles + `spec.rules`), so a generator
 *      reads a tunable through `ctx.rules` instead of a private constant;
 *   2. the ISSUES LEDGER is created over the legacy `warnings` array, so a discipline can replace a
 *      `warnings.push(...)` with `ctx.issues.add({...})` and produce a byte-identical string while it migrates.
 *
 * Then the single owner of every structural number (`presizeStructure`) runs BEFORE architecture, and the
 * coordination kernel is built from it as soon as architecture has published its shafts — so MEP asks for space
 * instead of checking for clashes.
 */
import type { BuildingSpec, DesignModel, GenContext, ModelElement, PatternApplication, StoreyDef } from './core/types.ts';
import { normalizeSpec, buildStoreys, type PartialSpec } from './core/spec.ts';
import { getTypology } from './core/typologies.ts';
import { createRng } from './core/rng.ts';
import { PatternBook, CROSS_PATTERNS } from './core/patterns.ts';

import { createLedger } from './core/rules/ledger.ts';
import { createRuleSet, check } from './core/rules/engine.ts';
import { builtinRules } from './core/rules/builtin.ts';
import { rulesFromPatterns } from './core/rules/from-patterns.ts';
import { validateRuleOverrides } from './core/rules/schema.ts';
import { roomGraphOf } from './core/rules/graph.ts';
import type { RoomGraph, RuleSet, World } from './core/rules/types.ts';
import type { Ledger } from './core/rules/types.ts';
import type { MigratingLedger } from './core/rules/ledger.ts';
import { createProfileBook } from './core/kernel/profiles.ts';
import { createKernel } from './core/kernel/registry.ts';
import { checkSupport } from './core/kernel/support.ts';
import type { Kernel } from './core/kernel/types.ts';
import { presizeStructure, type StructuralPresize } from './disciplines/structure/presize.ts';

import { generateSite, SITE_PATTERNS } from './disciplines/site/index.ts';
import { generateArchitecture, ARCH_PATTERNS } from './disciplines/architecture/index.ts';
import { generateStructure, STRUCT_PATTERNS } from './disciplines/structure/index.ts';
import { generateMechanical, MECH_PATTERNS } from './disciplines/mechanical/index.ts';
import { generatePlumbing, PLUMB_PATTERNS } from './disciplines/plumbing/index.ts';
import { generateElectrical, ELEC_PATTERNS } from './disciplines/electrical/index.ts';
import { computeMetrics } from './core/metrics.ts';

export interface GenerateOptions {
  /** Progress callback for the app worker: phase name and overall fraction complete */
  onPhase?: (phase: string, pct: number) => void;
}

export function generateBuilding(input: PartialSpec | BuildingSpec, options?: GenerateOptions): DesignModel {
  const spec: BuildingSpec = isFullSpec(input) ? input : normalizeSpec(input);
  const typology = getTypology(spec.typology);
  const rng = createRng(spec.seed);
  const warnings: string[] = [];
  const timings: Record<string, number> = {};
  const book = new PatternBook();
  book.register(...CROSS_PATTERNS, ...SITE_PATTERNS, ...ARCH_PATTERNS, ...STRUCT_PATTERNS, ...MECH_PATTERNS, ...PLUMB_PATTERNS, ...ELEC_PATTERNS);

  const onPhase = options?.onPhase;
  const phase = (name: string, pct: number): void => {
    onPhase?.(name, pct);
  };

  // --- rules + issues ------------------------------------------------------------------------------------------
  phase('rules', 0.01);
  const tRules = now();
  const ledger: MigratingLedger = createLedger({ mirrorInto: warnings });
  const { overrides, issues: overrideIssues } = validateRuleOverrides(spec.rules);
  for (const i of overrideIssues) ledger.add(i);
  const rules: RuleSet = createRuleSet({
    builtin: builtinRules(),
    fromPatterns: rulesFromPatterns(book.all()),
    overrides: overrides ?? undefined,
    spec,
    typology,
    ledger,
  });
  const profiles = createProfileBook(rules);
  timings.rules = now() - tRules;

  // --- site ---------------------------------------------------------------------------------------------------
  phase('site', 0.05);
  const t0 = now();
  const site = generateSite(spec, typology, rng.fork('site'), warnings, rules, ledger);
  timings.site = now() - t0;

  const storeys = site.massing.storeys.length > 0 ? site.massing.storeys : buildStoreys(spec, spec.floors);

  // --- structural pre-sizing: the single owner of slab / beam / core-wall / transfer / bay -----------------------
  phase('presize', 0.15);
  const tPresize = now();
  let presize: StructuralPresize | null = null;
  try {
    presize = presizeStructure({ spec, typology, site, storeys, profiles, rules, ledger });
  } catch (e) {
    presize = null;
    ledger.add({
      severity: 'info',
      ruleId: 'XD-00.presizePending',
      discipline: 'structure',
      message: `structural pre-sizing is not available yet (${e instanceof Error ? e.message : String(e)}); disciplines fall back to their v1 constants and the coordination kernel is not built`,
      source: 'presize',
    });
  }
  timings.presize = now() - tPresize;
  const resolvedStoreys: StoreyDef[] = presize && presize.storeysResolved.length > 0 ? presize.storeysResolved : storeys;

  const ctx: GenContext = {
    spec, typology, rng, storeys: resolvedStoreys, site,
    arch: null, struct: null, mech: null, plumb: null, elec: null,
    warnings, presize, kernel: null, rules, issues: ledger, onPhase,
  };

  // --- architecture -------------------------------------------------------------------------------------------
  phase('architecture', 0.2);
  const t1 = now();
  ctx.arch = generateArchitecture({ ...ctx, rng: rng.fork('architecture') });
  timings.architecture = now() - t1;

  // --- coordination kernel: profiles, lanes, shafts, chases, sleeves -------------------------------------------
  phase('kernel', 0.45);
  const tKernel = now();
  let kernel: Kernel | null = null;
  if (presize) {
    kernel = createKernel({ storeys: resolvedStoreys, presize, profiles, rules, ledger, arch: ctx.arch, site });
    ctx.kernel = kernel;
  }
  timings.kernel = now() - tKernel;

  if (spec.options.structure) {
    phase('structure', 0.5);
    const t = now();
    ctx.struct = generateStructure({ ...ctx, rng: rng.fork('structure') });
    timings.structure = now() - t;
  }
  if (spec.options.mechanical) {
    phase('mechanical', 0.6);
    const t = now();
    ctx.mech = generateMechanical({ ...ctx, rng: rng.fork('mechanical') });
    timings.mechanical = now() - t;
  }
  if (spec.options.plumbing) {
    phase('plumbing', 0.7);
    const t = now();
    ctx.plumb = generatePlumbing({ ...ctx, rng: rng.fork('plumbing') });
    timings.plumbing = now() - t;
  }
  if (spec.options.electrical) {
    phase('electrical', 0.8);
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
  assertUniqueIds(elements, ledger);

  const applications: PatternApplication[] = [
    ...site.patterns,
    ...ctx.arch.patterns,
    ...(ctx.struct?.patterns ?? []),
    ...(ctx.mech?.patterns ?? []),
    ...(ctx.plumb?.patterns ?? []),
    ...(ctx.elec?.patterns ?? []),
  ];
  for (const a of applications) {
    if (!book.get(a.patternId)) {
      ledger.add({
        severity: 'error', ruleId: 'XD-00.unknownPattern', discipline: 'xd',
        message: `Pattern application references unknown pattern ${a.patternId}`,
      });
    } else {
      book.apply(a);
    }
  }

  // --- validation: reservations, constructability, rules --------------------------------------------------------
  phase('validate', 0.9);
  const tValidate = now();
  const graph: RoomGraph = roomGraphOf(ctx.arch);
  // The cross-discipline validators report the real state of the model, which in wave 1 is still v1's: their
  // findings go into `model.issues` (the app's issues panel, `presets.test.ts`) but NOT into the legacy `warnings`
  // strings, whose consumers still expect the v1 lines. Wave 3 deletes `warnings` and this suspension with it.
  const mirrorWas = ledger.mirroring(false);
  if (kernel && presize) {
    const tReservations = now();
    kernel.validate(elements);
    timings.validateReservations = now() - tReservations;

    const tSupport = now();
    checkSupport({
      elements, kernel, storeys: resolvedStoreys, presize, invert: null, rules, ledger, region: spec.region,
    });
    timings.validateSupport = now() - tSupport;

    const tWorld = now();
    const elementById = new Map<string, ModelElement>();
    for (const e of elements) elementById.set(e.id, e);
    const roomById = new Map(ctx.arch.rooms.map(r => [r.id, r] as const));
    const world: World = {
      spec, typology, storeys: resolvedStoreys, site,
      arch: ctx.arch, struct: ctx.struct, mech: ctx.mech, plumb: ctx.plumb, elec: ctx.elec,
      presize, kernel, graph, invert: null, elementById, roomById,
    };
    timings.validateWorld = now() - tWorld;

    const tRules = now();
    check({ rules, world, ledger });
    timings.validateRules = now() - tRules;
  }
  ledger.mirroring(mirrorWas);
  timings.validate = now() - tValidate;

  const model: DesignModel = {
    spec,
    typology,
    storeys: resolvedStoreys,
    site,
    arch: ctx.arch,
    struct: ctx.struct,
    mech: ctx.mech,
    plumb: ctx.plumb,
    elec: ctx.elec,
    elements,
    metrics: [],
    patterns: { book: book.all(), applications: book.trace() },
    warnings: ledger.warnings(),
    timings,
    issues: [...ledger.all()],
    rules: [...rules.all()],
  };
  phase('metrics', 0.95);
  const t2 = now();
  model.metrics = computeMetrics(model);
  timings.metrics = now() - t2;
  phase('done', 1);
  return model;
}

function isFullSpec(s: PartialSpec | BuildingSpec): s is BuildingSpec {
  return typeof (s as BuildingSpec).seed === 'number' && !!(s as BuildingSpec).options && !!(s as BuildingSpec).site && typeof (s as BuildingSpec).site.width === 'number' && Array.isArray((s as BuildingSpec).floors) && (s as BuildingSpec).floors.length > 0;
}

function assertUniqueIds(elements: ModelElement[], ledger: Ledger): void {
  const seen = new Set<string>();
  for (const e of elements) {
    if (seen.has(e.id)) {
      ledger.add({
        severity: 'violation', ruleId: 'XD-00.uniqueElementId', discipline: 'xd', storey: e.storey,
        elementIds: [e.id], message: `Duplicate element id ${e.id}`,
      });
    }
    seen.add(e.id);
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
