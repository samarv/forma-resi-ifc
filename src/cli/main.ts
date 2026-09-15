/**
 * forma-resi-ifc command line interface.
 *
 *   node src/cli/main.ts --preset us-5-over-1 [--out dir] [--seed 7] [--schema IFC4]
 *                        [--no-mep] [--detail low|medium|high] [--validate] [--report]
 *   node src/cli/main.ts --spec my-building.json --report
 *   node src/cli/main.ts --all-presets --out dist/samples
 *   node src/cli/main.ts --list-presets | --list-typologies | --list-templates
 *
 * Writes `<out>/<name>.ifc` and, with --report, `<out>/<name>.report.json`.
 * Exit code 1 when the written IFC fails structural validation (or on bad input).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import type { BuildingSpec, DesignModel, MetricResult, ModelElement } from '../core/types.ts';
import { PRESETS, getPreset, UNIT_TEMPLATE_IDS, type PartialSpec } from '../core/spec.ts';
import { TYPOLOGIES, TYPOLOGY_IDS } from '../core/typologies.ts';
import { writeIfc } from '../ifc/writer.ts';
import { validateStep, type ValidationResult } from '../ifc/validate.ts';
import { METRICS } from '../core/metrics.ts';

const USAGE = `forma-resi-ifc — parametric residential building → IFC

Usage
  node src/cli/main.ts --preset <id> [options]
  node src/cli/main.ts --spec <file.json> [options]
  node src/cli/main.ts --all-presets [options]

Options
  --preset <id>        named preset (see --list-presets)
  --spec <file.json>   partial spec JSON (must contain at least "typology")
  --all-presets        generate every preset
  --out <dir>          output directory (default dist/samples)
  --seed <n>           override the spec seed
  --schema <s>         IFC2X3 | IFC4 | IFC4X3 (default IFC4)
  --detail <d>         low | medium | high (element density, default medium)
  --no-mep             skip mechanical, plumbing and electrical
  --no-site            skip site works and landscape
  --validate           print the STEP validation detail block
  --no-validate        skip validation (and its exit code)
  --report             write <name>.report.json next to the IFC
  --list-presets       list presets and exit
  --list-typologies    list building typologies and exit
  --list-templates     list dwelling templates and exit
  --help               this text
`;

interface Options {
  out: string;
  seed?: number;
  schema?: 'IFC2X3' | 'IFC4' | 'IFC4X3';
  detail?: 'low' | 'medium' | 'high';
  noMep: boolean;
  noSite: boolean;
  validate: boolean;
  showValidation: boolean;
  report: boolean;
}

/** Injectable dependencies — only used by tests, the CLI resolves them itself. */
export interface MainDeps {
  generate?: (input: PartialSpec | BuildingSpec) => DesignModel;
}

async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        preset: { type: 'string' },
        spec: { type: 'string' },
        out: { type: 'string' },
        seed: { type: 'string' },
        schema: { type: 'string' },
        detail: { type: 'string' },
        'all-presets': { type: 'boolean' },
        'no-mep': { type: 'boolean' },
        'no-site': { type: 'boolean' },
        validate: { type: 'boolean' },
        'no-validate': { type: 'boolean' },
        report: { type: 'boolean' },
        'list-presets': { type: 'boolean' },
        'list-typologies': { type: 'boolean' },
        'list-templates': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
    return 1;
  }
  const flags = parsed.values;

  if (flags.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (flags['list-presets']) {
    for (const preset of PRESETS) {
      process.stdout.write(`${preset.id.padEnd(16)} ${preset.label}\n`);
    }
    return 0;
  }
  if (flags['list-typologies']) {
    for (const id of TYPOLOGY_IDS) {
      const t = TYPOLOGIES[id];
      const regional = Object.entries(t.regionalNames).map(([r, n]) => `${r}: ${n}`).join('; ');
      process.stdout.write(`${id.padEnd(20)} ${t.name}\n${' '.repeat(21)}${t.storeys.min}–${t.storeys.max} storeys, ${t.access}, ${t.density.min}–${t.density.max} dph\n${regional ? `${' '.repeat(21)}${regional}\n` : ''}`);
    }
    return 0;
  }
  if (flags['list-templates']) {
    await listTemplates();
    return 0;
  }

  const options: Options = {
    out: flags.out ?? join('dist', 'samples'),
    seed: flags.seed !== undefined ? Number(flags.seed) : undefined,
    schema: flags.schema as Options['schema'],
    detail: flags.detail as Options['detail'],
    noMep: flags['no-mep'] === true,
    noSite: flags['no-site'] === true,
    validate: flags['no-validate'] !== true,
    showValidation: flags.validate === true,
    report: flags.report === true,
  };

  if (options.seed !== undefined && !Number.isFinite(options.seed)) {
    process.stderr.write(`--seed must be a number\n`);
    return 1;
  }
  if (options.schema && !['IFC2X3', 'IFC4', 'IFC4X3'].includes(options.schema)) {
    process.stderr.write(`--schema must be IFC2X3, IFC4 or IFC4X3\n`);
    return 1;
  }
  if (options.detail && !['low', 'medium', 'high'].includes(options.detail)) {
    process.stderr.write(`--detail must be low, medium or high\n`);
    return 1;
  }

  const jobs: { name: string; spec: PartialSpec }[] = [];
  if (flags['all-presets']) {
    for (const preset of PRESETS) jobs.push({ name: preset.id, spec: preset.spec });
  } else if (flags.preset) {
    let preset;
    try {
      preset = getPreset(flags.preset);
    } catch {
      process.stderr.write(`unknown preset '${flags.preset}'. Known: ${PRESETS.map(p => p.id).join(', ')}\n`);
      return 1;
    }
    jobs.push({ name: preset.id, spec: preset.spec });
  } else if (flags.spec) {
    try {
      const raw = readFileSync(resolve(flags.spec), 'utf8');
      const spec = JSON.parse(raw) as PartialSpec;
      if (!spec || typeof spec !== 'object' || !spec.typology) {
        process.stderr.write(`${flags.spec}: spec JSON must be an object with a "typology" field\n`);
        return 1;
      }
      jobs.push({ name: slug(spec.name ?? spec.typology), spec });
    } catch (error) {
      process.stderr.write(`cannot read spec '${flags.spec}': ${(error as Error).message}\n`);
      return 1;
    }
  } else {
    process.stdout.write(USAGE);
    return 1;
  }

  // The pipeline pulls in all six discipline modules; import it lazily and only
  // once the inputs are known good, so the listing flags and argument errors
  // keep working while those modules are still being written.
  let generateBuilding: (input: PartialSpec | BuildingSpec) => DesignModel;
  if (deps.generate) {
    generateBuilding = deps.generate;
  } else {
    try {
      ({ generateBuilding } = await import('../pipeline.ts'));
    } catch (error) {
      process.stderr.write(`cannot load the generation pipeline — the discipline modules are not all present yet:\n  ${(error as Error).message}\n`);
      return 1;
    }
  }

  mkdirSync(resolve(options.out), { recursive: true });

  let failures = 0;
  for (const job of jobs) {
    try {
      const failed = runJob(job.name, job.spec, options, generateBuilding);
      if (failed) failures += 1;
    } catch (error) {
      failures += 1;
      process.stderr.write(`${job.name}: generation failed — ${(error as Error).stack ?? (error as Error).message}\n`);
    }
  }
  return failures > 0 ? 1 : 0;
}

function runJob(
  name: string,
  partial: PartialSpec,
  options: Options,
  generateBuilding: (input: PartialSpec | BuildingSpec) => DesignModel,
): boolean {
  const input: PartialSpec = {
    ...partial,
    seed: options.seed ?? partial.seed,
    options: {
      ...(partial.options ?? {}),
      ...(options.detail ? { detail: options.detail } : {}),
      ...(options.schema ? { ifcSchema: options.schema } : {}),
      ...(options.noMep ? { mechanical: false, plumbing: false, electrical: false } : {}),
      ...(options.noSite ? { site: false } : {}),
    },
  };

  const t0 = Date.now();
  const model = generateBuilding(input);
  const generateMs = Date.now() - t0;

  const t1 = Date.now();
  const ifc = writeIfc(model, { schema: options.schema ?? model.spec.options.ifcSchema, deterministic: true });
  const writeMs = Date.now() - t1;

  const outDir = resolve(options.out);
  const ifcPath = join(outDir, `${name}.ifc`);
  writeFileSync(ifcPath, ifc.content, 'utf8');

  let validation: ValidationResult | null = null;
  let validateMs = 0;
  if (options.validate) {
    const t2 = Date.now();
    validation = validateStep(ifc.content);
    validateMs = Date.now() - t2;
  }

  const timings = { ...model.timings, generate: generateMs, writeIfc: writeMs, validate: validateMs };
  const counts = elementCounts(model.elements);
  const patternCounts = countBy(model.patterns.applications.map(a => a.patternId));

  printSummary(name, model, ifc, ifcPath, validation, timings, counts, options);

  if (options.report) {
    const reportPath = join(outDir, `${name}.report.json`);
    const report = {
      generator: 'forma-resi-ifc',
      preset: name,
      spec: model.spec,
      typology: { id: model.typology.id, name: model.typology.name },
      storeys: model.storeys.map(s => ({ id: s.id, name: s.name, elevation: s.elevation, height: s.height, use: s.use })),
      metrics: model.metrics.map(m => ({
        id: m.id,
        rank: METRICS.find(d => d.id === m.id)?.rank ?? 99,
        name: METRICS.find(d => d.id === m.id)?.name ?? m.id,
        value: m.value,
        display: m.display,
        unit: m.unit,
        status: m.status ?? 'ok',
        note: m.note,
        breakdown: m.breakdown,
      })),
      patterns: {
        registered: model.patterns.book.length,
        applications: model.patterns.applications.length,
        byPattern: patternCounts,
      },
      elements: {
        total: model.elements.length,
        written: Object.keys(ifc.idMap).length,
        byDiscipline: counts.byDiscipline,
        byIfcType: counts.byIfcType,
        byGeometryKind: counts.byGeometryKind,
        byStorey: counts.byStorey,
      },
      ifc: {
        file: `${name}.ifc`,
        schema: options.schema ?? model.spec.options.ifcSchema,
        entityCount: ifc.entityCount,
        fileSize: ifc.fileSize,
      },
      validation: validation ?? 'skipped',
      warnings: { model: model.warnings, writer: ifc.warnings ?? [] },
      timings,
    };
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`  report          ${reportPath}\n`);
  }

  return validation !== null && !validation.ok;
}

// ============================================================================
// Output helpers
// ============================================================================

interface Counts {
  byDiscipline: Record<string, number>;
  byIfcType: Record<string, number>;
  byGeometryKind: Record<string, number>;
  byStorey: Record<string, number>;
}

function elementCounts(elements: ModelElement[]): Counts {
  const byDiscipline: Record<string, number> = {};
  const byIfcType: Record<string, number> = {};
  const byGeometryKind: Record<string, number> = {};
  const byStorey: Record<string, number> = {};
  for (const e of elements) {
    byDiscipline[e.discipline] = (byDiscipline[e.discipline] ?? 0) + 1;
    byIfcType[e.ifcType] = (byIfcType[e.ifcType] ?? 0) + 1;
    const kind = e.geometry?.kind ?? 'none';
    byGeometryKind[kind] = (byGeometryKind[kind] ?? 0) + 1;
    byStorey[e.storey] = (byStorey[e.storey] ?? 0) + 1;
  }
  return { byDiscipline, byIfcType, byGeometryKind, byStorey };
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

/** Printed in rank order; the rest of the sheet only goes into the report JSON. */
const HEADLINE_METRICS = [
  'gfa', 'nia', 'efficiency', 'far', 'site-coverage', 'density-dph', 'unit-count', 'unit-mix',
  'avg-unit-area', 'building-height', 'circulation-ratio', 'wwr', 'dual-aspect', 'parking-ratio',
  'open-space-per-unit', 'egress-travel', 'electrical-service', 'plumbing-dfu', 'cooling-load',
  'embodied-carbon', 'eui', 'construction-cost',
].sort((a, b) => (METRICS.find(m => m.id === a)?.rank ?? 99) - (METRICS.find(m => m.id === b)?.rank ?? 99));

function printSummary(
  name: string,
  model: DesignModel,
  ifc: { entityCount: number; fileSize: number; idMap: Record<string, number>; warnings?: string[] },
  ifcPath: string,
  validation: ValidationResult | null,
  timings: Record<string, number>,
  counts: Counts,
  options: Options,
): void {
  const out: string[] = [];
  out.push(`\n${model.spec.name}  [${name}]`);
  out.push(`  typology        ${model.typology.name} (${model.spec.typology}), ${model.spec.region}, seed ${model.spec.seed}`);
  out.push(`  site            ${model.spec.site.width} × ${model.spec.site.depth} m, ${model.spec.massing.storeys} storeys, ${model.storeys.length} IFC storeys`);
  out.push(`  elements        ${model.elements.length} (${Object.keys(ifc.idMap).length} written) — ${topN(counts.byDiscipline, 6)}`);
  out.push(`  ifc types       ${topN(counts.byIfcType, 6)}`);
  out.push(`  file            ${ifcPath} — ${ifc.entityCount} entities, ${(ifc.fileSize / 1_048_576).toFixed(2)} MiB`);

  const metricById = new Map<string, MetricResult>(model.metrics.map(m => [m.id, m]));
  out.push('');
  out.push(`  ${'metric'.padEnd(26)}${'value'.padEnd(26)}status`);
  out.push(`  ${'-'.repeat(26)}${'-'.repeat(26)}------`);
  for (const id of HEADLINE_METRICS) {
    const metric = metricById.get(id);
    if (!metric) continue;
    const def = METRICS.find(d => d.id === id);
    const label = `${def?.rank ?? '·'}. ${def?.name ?? id}`;
    out.push(`  ${truncate(label, 25).padEnd(26)}${truncate(metric.display, 25).padEnd(26)}${statusMark(metric.status)}`);
  }

  const patternCount = model.patterns.applications.length;
  out.push('');
  out.push(`  patterns        ${patternCount} applications of ${new Set(model.patterns.applications.map(a => a.patternId)).size} patterns`);
  out.push(`  timings         ${Object.entries(timings).map(([k, v]) => `${k} ${Math.round(v)}ms`).join(', ')}`);

  if (validation) {
    const verdict = validation.ok ? 'PASS' : `FAIL (${validation.errors.length} errors)`;
    out.push(`  validation      ${verdict} — ${validation.schema}, ${validation.entityCount} entities, ${validation.unresolvedRefs} unresolved refs`);
    if (options.showValidation || !validation.ok) {
      for (const error of validation.errors.slice(0, 20)) out.push(`    error: ${error}`);
      for (const warning of validation.warnings.slice(0, 10)) out.push(`    warn:  ${warning}`);
      if (options.showValidation) {
        out.push(`    entity mix: ${topN(validation.byType, 10)}`);
      }
    }
  }

  const writerWarnings = ifc.warnings ?? [];
  if (model.warnings.length > 0 || writerWarnings.length > 0) {
    out.push(`  warnings        model ${model.warnings.length}, writer ${writerWarnings.length}`);
    for (const w of [...model.warnings.slice(0, 5), ...writerWarnings.slice(0, 5)]) out.push(`    ${w}`);
  }

  process.stdout.write(`${out.join('\n')}\n`);
}

function statusMark(status: MetricResult['status']): string {
  if (status === 'fail') return 'FAIL';
  if (status === 'warn') return 'warn';
  return 'ok';
}

function topN(counts: Record<string, number>, n: number): string {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const head = entries.slice(0, n).map(([k, v]) => `${k} ${v}`).join(', ');
  return entries.length > n ? `${head}, +${entries.length - n} more` : head || 'none';
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'building';
}

/**
 * Dwelling templates live in the architecture module. Print the catalog when it
 * exists, otherwise just the ids from the shared contract.
 */
async function listTemplates(): Promise<void> {
  const candidates = [
    '../disciplines/architecture/unit-templates.ts',
    '../disciplines/architecture/templates.ts',
    '../disciplines/architecture/index.ts',
  ];
  for (const candidate of candidates) {
    try {
      const mod = await import(candidate) as Record<string, unknown>;
      const catalog = (mod.UNIT_TEMPLATES ?? mod.TEMPLATES ?? mod.UNIT_TEMPLATE_CATALOG) as
        | Record<string, { name?: string; bedrooms?: number; bathrooms?: number; area?: { target?: number } }>
        | undefined;
      if (catalog && typeof catalog === 'object') {
        for (const [id, template] of Object.entries(catalog)) {
          const area = template?.area?.target;
          process.stdout.write(`${id.padEnd(22)} ${template?.name ?? ''}${template?.bedrooms !== undefined ? ` — ${template.bedrooms}b${template.bathrooms ?? ''}` : ''}${area ? `, ${area} m²` : ''}\n`);
        }
        return;
      }
    } catch {
      // module not written yet — try the next candidate
    }
  }
  for (const id of UNIT_TEMPLATE_IDS) process.stdout.write(`${id}\n`);
  process.stdout.write(`\n(${UNIT_TEMPLATE_IDS.length} template ids from the shared contract; the architecture module's catalog is not available yet)\n`);
}

// Only auto-run when invoked as a script (keeps the module importable in tests).
const invokedDirectly = process.argv[1] !== undefined && /main\.ts$/.test(process.argv[1]);
if (invokedDirectly) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}

export { main };
