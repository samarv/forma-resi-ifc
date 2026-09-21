/**
 * "Generators read the rules" — a source-text test.
 *
 * Two halves:
 *   #34 (live now)  every rule id a discipline reads through `rules.num(...)` / `rules.table(...)` / `ruleNum(...)`
 *                   exists in the resolved rule set. A generator that reads a rule id nobody defined silently gets
 *                   its own fallback for ever, which is exactly the duplicate constant the rule set is meant to kill.
 *   #33 (wave 3)    the identifiers that the kernel replaces are gone from the source. Skipped until the disciplines
 *                   have migrated; the assertion body is real, so unskipping is a one-word change.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, globSync } from 'node:fs';

import { createRuleSet } from './core/rules/engine.ts';
import { builtinRules } from './core/rules/builtin.ts';
import { rulesFromPatterns } from './core/rules/from-patterns.ts';
import { createLedger } from './core/rules/ledger.ts';
import { PatternBook, CROSS_PATTERNS } from './core/patterns.ts';
import { normalizeSpec, PRESETS } from './core/spec.ts';
import { getTypology } from './core/typologies.ts';
import { SITE_PATTERNS } from './disciplines/site/index.ts';
import { ARCH_PATTERNS } from './disciplines/architecture/index.ts';
import { STRUCT_PATTERNS } from './disciplines/structure/index.ts';
import { MECH_PATTERNS } from './disciplines/mechanical/index.ts';
import { PLUMB_PATTERNS } from './disciplines/plumbing/index.ts';
import { ELEC_PATTERNS } from './disciplines/electrical/index.ts';

function allPatterns(): ReturnType<PatternBook['all']> {
  const book = new PatternBook();
  book.register(...CROSS_PATTERNS, ...SITE_PATTERNS, ...ARCH_PATTERNS, ...STRUCT_PATTERNS, ...MECH_PATTERNS, ...PLUMB_PATTERNS, ...ELEC_PATTERNS);
  return book.all();
}

/** The rule set as the pipeline resolves it, for each region/typology the presets exercise. */
function ruleSets(): { id: string; set: ReturnType<typeof createRuleSet> }[] {
  const patterns = rulesFromPatterns(allPatterns());
  return PRESETS.map(preset => {
    const spec = normalizeSpec(preset.spec);
    return {
      id: preset.id,
      set: createRuleSet({
        builtin: builtinRules(), fromPatterns: patterns, spec, typology: getTypology(spec.typology),
        ledger: createLedger(), overrides: spec.rules,
      }),
    };
  });
}

const DISCIPLINE_FILES = globSync('src/disciplines/**/*.ts').filter(f => !f.endsWith('.test.ts')).sort();

test('#34 every rule id read by a discipline exists in the rule set', () => {
  const sets = ruleSets();
  const referenced = new Map<string, string[]>();
  // rules.num('X', 1) · rules.table('X') · ruleNum(rules, 'X', 1) · ctx.rules?.num('X', 1)
  const patterns = [
    /\.(?:num|str|bool|table)\(\s*'([A-Z][A-Za-z0-9-]*\.[A-Za-z0-9_.-]+)'/g,
    /ruleNum\(\s*[A-Za-z0-9_.?]+\s*,\s*'([A-Z][A-Za-z0-9-]*\.[A-Za-z0-9_.-]+)'/g,
  ];
  for (const file of DISCIPLINE_FILES) {
    const src = readFileSync(file, 'utf8');
    for (const re of patterns) {
      re.lastIndex = 0;
      let m = re.exec(src);
      while (m) {
        const list = referenced.get(m[1]) ?? [];
        list.push(file);
        referenced.set(m[1], list);
        m = re.exec(src);
      }
    }
  }
  assert.ok(referenced.size > 0, 'the regex found no rule reads at all — has the read convention changed?');

  const missing: string[] = [];
  for (const id of [...referenced.keys()].sort()) {
    const known = sets.every(s => s.set.get(id) !== null || paramOfExists(s.set, id));
    if (!known) missing.push(`${id}  (read in ${[...new Set(referenced.get(id) ?? [])].join(', ')})`);
  }
  assert.deepEqual(missing, [], `rule ids read by a discipline but absent from the rule set:\n  ${missing.join('\n  ')}`);
});

/** `num('RULE.param')` also resolves through the owning rule's named parameter. */
function paramOfExists(set: ReturnType<typeof createRuleSet>, id: string): boolean {
  const cut = id.lastIndexOf('.');
  if (cut <= 0) return false;
  const base = set.get(id.slice(0, cut));
  return !!base && base.params[id.slice(cut + 1)] !== undefined;
}

test('#34b every rule id a site issue reports against exists in the rule set', () => {
  const sets = ruleSets();
  const src = readFileSync('src/disciplines/site/issues.ts', 'utf8');
  const re = /:\s*'([A-Z][A-Za-z0-9-]*\.[A-Za-z0-9_.-]+)'/g;
  const ids = new Set<string>();
  let m = re.exec(src);
  while (m) {
    ids.add(m[1]);
    m = re.exec(src);
  }
  const missing = [...ids].sort().filter(id => !sets.every(s => s.set.get(id) !== null || paramOfExists(s.set, id)));
  assert.deepEqual(missing, [], `site reports against rule ids that do not exist: ${missing.join(', ')}`);
});

test('#33 the identifiers the kernel replaces are gone from the source', { skip: 'wave 3: the disciplines still read the v1 constants through the coordination shim' }, () => {
  const gone: { id: string; files: string[] }[] = [
    { id: 'SIZES.slabT', files: ['src/disciplines/architecture/index.ts', 'src/disciplines/structure/index.ts'] },
    { id: 'SIZES.coreWallT', files: ['src/disciplines/architecture/cores.ts'] },
    { id: 'plumbingShaftCorner', files: ['src/disciplines/plumbing/storm.ts', 'src/disciplines/plumbing/index.ts'] },
    { id: 'SHAFT_SLOT_CAPACITY', files: ['src/disciplines/mechanical/placement.ts'] },
    { id: 'beamDepthUnder', files: ['src/disciplines/mechanical/context.ts'] },
    { id: 'beamDepthFor', files: ['src/disciplines/electrical/panels.ts'] },
    { id: 'BUILDING_DRAIN_Z', files: ['src/disciplines/plumbing/state.ts', 'src/disciplines/plumbing/index.ts'] },
    { id: 'SEWER_Z', files: ['src/disciplines/plumbing/state.ts', 'src/disciplines/plumbing/index.ts'] },
    { id: 'MAX_VENTED_BRANCH', files: ['src/disciplines/plumbing/stacks.ts'] },
    { id: 'DEFAULT_LANES', files: DISCIPLINE_FILES },
    { id: 'plenumBands', files: DISCIPLINE_FILES },
  ];
  const found: string[] = [];
  for (const g of gone) {
    for (const file of g.files) {
      let src = '';
      try {
        src = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (src.includes(g.id)) found.push(`${g.id} in ${file}`);
    }
  }
  assert.deepEqual(found, [], `identifiers that should have been deleted:\n  ${found.join('\n  ')}`);
});

test('#33b core/coordination.ts is gone', { skip: 'wave 3: the shim is deleted with the last v1 consumer' }, () => {
  assert.equal(globSync('src/core/coordination.ts').length, 0, 'the v1 coordination shim should be deleted in wave 3');
});
