/**
 * Rules tests #8–#13 of docs/design/v2-design-kernel-rules-presize.md §6.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Pattern } from '../types.ts';
import { PatternBook, CROSS_PATTERNS } from '../patterns.ts';
import { SITE_PATTERNS } from '../../disciplines/site/index.ts';
import { ARCH_PATTERNS } from '../../disciplines/architecture/index.ts';
import { STRUCT_PATTERNS } from '../../disciplines/structure/index.ts';
import { MECH_PATTERNS } from '../../disciplines/mechanical/index.ts';
import { PLUMB_PATTERNS } from '../../disciplines/plumbing/index.ts';
import { ELEC_PATTERNS } from '../../disciplines/electrical/index.ts';
import { normalizeSpec } from '../spec.ts';
import { getTypology } from '../typologies.ts';

import { createLedger, warningString } from './ledger.ts';
import { createRuleSet, patternParamOverrides, scopeMatches } from './engine.ts';
import { builtinRules, KERNEL_RULE_IDS, RULE_PROFILES, RULE_PROFILE_NAMES } from './builtin.ts';
import { numericParamIds, rulesFromPatterns } from './from-patterns.ts';
import { PREDICATES, PREDICATE_IDS, PREDICATE_SIGNATURES } from './predicates.ts';
import { RULE_OVERRIDES_SCHEMA, customToRule, validateRuleOverrides } from './schema.ts';
import { buildRoomGraph } from './graph.ts';
import { isCited } from './SOURCES.ts';
import type { CustomRule, Rule, RuleOverrides } from './types.ts';

function allPatterns(): Pattern[] {
  const book = new PatternBook();
  book.register(...CROSS_PATTERNS, ...SITE_PATTERNS, ...ARCH_PATTERNS, ...STRUCT_PATTERNS, ...MECH_PATTERNS, ...PLUMB_PATTERNS, ...ELEC_PATTERNS);
  return book.all();
}

const PATTERNS = allPatterns();
const LIFTED = rulesFromPatterns(PATTERNS);
const BUILTIN = builtinRules();
const SPEC = normalizeSpec({ region: 'US', typology: 'corridor-midrise', site: { width: 78, depth: 42 }, massing: { storeys: 6, roof: 'flat' } });
const TYPOLOGY = getTypology(SPEC.typology);

function set(overrides?: RuleOverrides, spec = SPEC) {
  const ledger = createLedger();
  const rules = createRuleSet({ builtin: BUILTIN, fromPatterns: LIFTED, overrides, spec, typology: getTypology(spec.typology), ledger });
  return { rules, ledger };
}

// ---------------------------------------------------------------------------------------------------------------
// #8 — pattern lifting
// ---------------------------------------------------------------------------------------------------------------

test('#8 every numeric pattern parameter becomes a param rule, with a source and no id collisions', () => {
  assert.ok(PATTERNS.length >= 100, `expected the full pattern book, got ${PATTERNS.length}`);
  const ids = LIFTED.map(r => r.id);
  assert.equal(new Set(ids).size, ids.length, 'lifted rule ids are unique');

  const wanted = numericParamIds(PATTERNS);
  const have = new Set(ids);
  const missing = wanted.filter(id => !have.has(id));
  assert.deepEqual(missing, [], `numeric pattern parameters with no rule: ${missing.join(', ')}`);
  assert.ok(wanted.length >= 400, `expected 400+ numeric parameters, got ${wanted.length}`);

  for (const r of LIFTED) {
    assert.equal(r.kind, 'param');
    assert.ok(r.patternId && r.id.startsWith(`${r.patternId}.`), `${r.id} does not name its pattern`);
    assert.ok(r.params.value, `${r.id} has no value`);
    assert.ok(r.params.value.source.length > 0, `${r.id} has an empty source`);
    assert.notEqual(r.discipline, 'cross', 'the pattern book’s ‘cross’ is ‘xd’ in the rule set');
  }

  // Reading a lifted parameter returns the pattern's value, not the caller's fallback.
  const { rules } = set();
  assert.equal(rules.num('ARC-03.maxLegLength', 999), 45);
  assert.equal(rules.num('XD-01.maxFixtureDistanceToStack', 999), 3.0);
  assert.equal(rules.num('ARC-03.nonexistent', 7), 7, 'an unknown parameter falls back');

  // The built-ins that deliberately replace a lifted parameter are the corrected tables, and no others.
  assert.deepEqual(patternParamOverrides(BUILTIN, LIFTED), [], 'no built-in silently shadows a pattern parameter');
});

test('#8b XD-06…XD-12 are registered with sourced parameters and read from the kernel tables', () => {
  const ids = ['XD-06', 'XD-07', 'XD-08', 'XD-09', 'XD-10', 'XD-11', 'XD-12'];
  for (const id of ids) {
    const p = PATTERNS.find(x => x.id === id);
    assert.ok(p, `${id} is not registered`);
    assert.equal(p.discipline, 'cross');
    assert.ok(p.problem.length > 80 && p.solution.length > 80, `${id} needs an Alexander-style problem/solution`);
    assert.ok(Object.keys(p.parameters).length >= 5, `${id} has too few parameters`);
    for (const [name, param] of Object.entries(p.parameters)) {
      assert.ok((param.source ?? '').length > 0, `${id}.${name} has no source`);
    }
  }
  const { rules } = set();
  // The pattern parameter and the kernel table are the same number, because the pattern reads the table.
  assert.equal(rules.num('XD-06.corridorClearMin', 0), 2.1);
  assert.equal(rules.num('XD-08.accessibleRouteClear', 0), 2.5);
  assert.equal(rules.num('XD-12.ductSpacing', 0), 2.44);
  assert.equal(rules.num('XD-11.slope100to150', 0), 0.01);
  assert.equal(rules.num('XD-06.band.resi-corridor.service.depth', 0), 0.3);
});

// ---------------------------------------------------------------------------------------------------------------
// #9 — predicates and signatures
// ---------------------------------------------------------------------------------------------------------------

test('#9 every predicate has an implementation, a signature, and consistent built-in usage', () => {
  const impl = Object.keys(PREDICATES).sort();
  const sigs = Object.keys(PREDICATE_SIGNATURES).sort();
  assert.deepEqual(impl, sigs, 'PREDICATES and PREDICATE_SIGNATURES must cover the same ids');
  assert.equal(PREDICATE_IDS.length, impl.length);
  assert.ok(impl.length >= 27, `the design fixes the vocabulary at 27+ predicates, got ${impl.length}`);
  for (const id of PREDICATE_IDS) {
    const sig = PREDICATE_SIGNATURES[id];
    assert.ok(typeof PREDICATES[id] === 'function', `${id} has no implementation`);
    assert.ok(sig.subjects.length > 0, `${id} accepts no subject`);
    assert.ok(sig.description.length > 20, `${id} has no description for the rule builder`);
    assert.ok(['number', 'string', 'boolean'].includes(sig.limitType));
  }

  for (const r of BUILTIN) {
    if (!r.predicate) continue;
    const sig = PREDICATE_SIGNATURES[r.predicate.id];
    assert.ok(sig, `${r.id} uses an unknown predicate ${r.predicate.id}`);
    const subject = r.subject ?? 'building';
    assert.ok(sig.subjects.includes(subject),
      `${r.id}: predicate ${r.predicate.id} does not accept a ${subject} (accepts ${sig.subjects.join(', ')})`);
    const declaresObject = (sig.object ?? []).filter(k => k !== 'none').length > 0;
    if (declaresObject) assert.ok(r.predicate.args.length > 0, `${r.id}: predicate ${r.predicate.id} needs an object argument`);
  }
});

test('#9b every built-in rule is sourced, titled and cites a pinned edition', () => {
  for (const r of BUILTIN) {
    assert.ok(r.title.length > 10, `${r.id} has no title`);
    assert.ok((r.rationale ?? '').length > 20, `${r.id} has no rationale`);
    for (const [name, param] of Object.entries(r.params)) {
      assert.ok(param.source.length > 0, `${r.id}.${name} has no source`);
      assert.ok(isCited(param.source) || param.source === 'spec' || param.source.includes(';'),
        `${r.id}.${name} cites an unpinned edition: ${param.source}`);
    }
  }
  const { rules } = set();
  for (const id of KERNEL_RULE_IDS) {
    assert.ok(rules.get(id) !== null || rules.num(id, -1) !== -1, `the kernel reports against ${id}, which no rule defines`);
  }
});

test('#9c rule profiles layer cleanly and are switched on by the building', () => {
  for (const name of RULE_PROFILE_NAMES) {
    assert.ok((RULE_PROFILES[name] ?? []).length > 0, `profile ${name} is empty`);
  }
  const us = set().rules;
  assert.ok(us.profileApplied('us'), 'a US spec applies the US profile');
  assert.ok(!us.profileApplied('uk'));
  assert.ok(!us.profileApplied('high-rise'), '6 storeys is not a high-rise');
  assert.equal(us.table('PLB-02.trapArm').length, 5);
  assert.deepEqual(us.table('PLB-02.trapArm')[2], [0.05, 1.83], 'IPC Table 1002.2: a 2 in trap arm is 1.83 m, not 1.5 m');

  const uk = set(undefined, normalizeSpec({ region: 'IE', typology: 'courtyard-block', site: { width: 70, depth: 64 }, massing: { storeys: 5, roof: 'flat' } })).rules;
  assert.ok(uk.profileApplied('uk'), 'an Irish spec applies the UK/IE profile');
  assert.equal(uk.num('PLB-01.slopeSanitary.1', 0), 1 / 80, 'BS EN 12056-2 / ADH: 1:80 on a Ø100 drain');
  assert.equal(uk.table('PLB-02.trapArm')[0][1], 1.7, 'ADH Table 8 branch lengths replace the IPC trap arms');

  const tower = set(undefined, normalizeSpec({ region: 'CA', typology: 'podium-tower', site: { width: 48, depth: 46 }, massing: { storeys: 22, roof: 'flat' } })).rules;
  assert.ok(tower.profileApplied('high-rise'), '22 storeys is a high-rise');
  assert.equal(tower.num('STR-05.coreWallT', 0), 0.3, 'the high-rise profile thickens the core wall');
  assert.equal(tower.num('XD-04.shaftAreaPerUnitServed', 0), 0.16);
});

// ---------------------------------------------------------------------------------------------------------------
// #10 — override validation
// ---------------------------------------------------------------------------------------------------------------

const GOOD_CUSTOM: CustomRule = {
  id: 'USR-bed-min-width',
  title: 'Bedrooms at least 2.7 m wide',
  subject: { kind: 'room', roomType: ['bedroom', 'master-bedroom'] },
  predicate: 'minDim',
  limit: { op: '>=', value: 2.7, unit: 'm' },
  scope: { floorUse: ['residential'] },
  severity: 'violation',
};

test('#10 validateRuleOverrides drops exactly the offending rule, with one error each', () => {
  const cases: { name: string; doc: unknown; expect: RegExp }[] = [
    { name: 'bad version', doc: { version: 2, custom: [GOOD_CUSTOM] }, expect: /version must be 1/ },
    { name: 'id without USR-', doc: { version: 1, custom: [{ ...GOOD_CUSTOM, id: 'bed-min' }] }, expect: /must match/ },
    { name: 'unknown predicate', doc: { version: 1, custom: [{ ...GOOD_CUSTOM, predicate: 'vibes' }] }, expect: /unknown predicate/ },
    { name: 'subject illegal for the predicate', doc: { version: 1, custom: [{ ...GOOD_CUSTOM, subject: { kind: 'door' } }] }, expect: /does not apply to a door/ },
    { name: 'limit type mismatch', doc: { version: 1, custom: [{ ...GOOD_CUSTOM, limit: { op: '>=', value: 'wide' } }] }, expect: /takes a number limit/ },
    { name: 'unknown scope member', doc: { version: 1, custom: [{ ...GOOD_CUSTOM, scope: { roomType: ['ballroom'] } }] }, expect: /unknown member/ },
    { name: 'duplicate id', doc: { version: 1, custom: [GOOD_CUSTOM, GOOD_CUSTOM] }, expect: /duplicate custom rule id/ },
    { name: 'object on a predicate that takes none', doc: { version: 1, custom: [{ ...GOOD_CUSTOM, object: { kind: 'roomType', value: 'kitchen' } }] }, expect: /takes no object/ },
    { name: 'missing object', doc: { version: 1, custom: [{ id: 'USR-adj', title: 'Kitchen next to dining', subject: { kind: 'room' }, predicate: 'adjacent', limit: { op: '==', value: true } }] }, expect: /needs an object/ },
    { name: 'reserved severity', doc: { version: 1, custom: [{ ...GOOD_CUSTOM, severity: 'error' }] }, expect: /severity must be/ },
    { name: 'unknown resolution', doc: { version: 1, custom: [{ ...GOOD_CUSTOM, resolution: 'pray' }] }, expect: /unknown resolution/ },
    { name: 'unknown profile', doc: { version: 1, profiles: ['mars'] }, expect: /unknown profile/ },
  ];
  for (const c of cases) {
    const { overrides, issues } = validateRuleOverrides(c.doc);
    assert.equal(issues.length, 1, `${c.name}: expected exactly one error, got ${issues.length}: ${issues.map(i => i.message).join(' | ')}`);
    assert.match(issues[0].message, c.expect, c.name);
    assert.equal(issues[0].severity, 'error');
    assert.equal(issues[0].ruleId, 'USR-SCHEMA');
    if (c.name === 'bad version') assert.equal(overrides, null, 'a bad version drops the whole document');
    else assert.ok(overrides, `${c.name}: the rest of the document survives`);
  }

  // A valid document produces no issues and keeps everything.
  const ok = validateRuleOverrides({
    version: 1,
    params: { 'ARC-03.maxLegLength': { value: 40 } },
    severity: { 'ARC-C5.corridorLeg': 'deviation' },
    disabled: ['ARC-C6.corridorDeadEnd'],
    profiles: ['sprinklered'],
    custom: [GOOD_CUSTOM],
  });
  assert.deepEqual(ok.issues, []);
  assert.equal(ok.overrides?.custom?.length, 1);
  assert.equal(ok.overrides?.params?.['ARC-03.maxLegLength'].value, 40);

  // Two bad rules in one document produce two errors and drop only those two.
  const mixed = validateRuleOverrides({ version: 1, custom: [GOOD_CUSTOM, { ...GOOD_CUSTOM, id: 'nope' }, { ...GOOD_CUSTOM, id: 'USR-2', predicate: 'vibes' }] });
  assert.equal(mixed.issues.length, 2);
  assert.equal(mixed.overrides?.custom?.length, 1);
});

test('#10b overrides applied to the set: params, severity, disabled, unknown ids', () => {
  const { rules, ledger } = set({
    version: 1,
    params: { 'ARC-03.maxLegLength': { value: 40 }, 'XD-99.nope': { value: 1 }, 'ARC-03.bogus': { value: 1 } },
    severity: { 'ARC-C5.corridorLeg': 'deviation' },
    disabled: ['ARC-C6.corridorDeadEnd', 'XD-98.nope'],
  });
  assert.equal(rules.num('ARC-03.maxLegLength', 999), 40, 'the project value wins');
  assert.equal(rules.get('ARC-C5.corridorLeg')?.severity, 'deviation');
  assert.ok(rules.disabled('ARC-C6.corridorDeadEnd'));
  assert.equal(rules.forSubject('corridor', { roomType: 'corridor' }).some(r => r.id === 'ARC-C6.corridorDeadEnd'), false,
    'a disabled rule is not evaluated');
  const errors = ledger.bySeverity('error');
  assert.equal(errors.length, 3, `unknown rule, unknown parameter and unknown disable: ${errors.map(e => e.message).join(' | ')}`);
  assert.equal(ledger.bySeverity('deviation').length, 1, 'an applied override is recorded as a deviation');
  assert.equal(rules.num('XD-06.habitableFloorToFloor', 0), 2.0, 'unrelated rules are untouched');
});

test('#10c the JSON schema describes what the validator accepts', () => {
  const schema = RULE_OVERRIDES_SCHEMA as Record<string, unknown>;
  assert.equal(schema.$schema, 'http://json-schema.org/draft-07/schema#');
  const props = (schema.properties ?? {}) as Record<string, unknown>;
  assert.deepEqual(Object.keys(props).sort(), ['custom', 'disabled', 'params', 'profiles', 'severity', 'version']);
  const custom = (props.custom as { items: { properties: Record<string, unknown>; required: string[] } }).items;
  assert.deepEqual(custom.required.sort(), ['id', 'limit', 'predicate', 'subject', 'title']);
  assert.ok(((custom.properties.predicate as { enum: string[] }).enum ?? []).length === PREDICATE_IDS.length,
    'the schema enumerates the same predicate vocabulary the engine implements');
});

// ---------------------------------------------------------------------------------------------------------------
// #11 — customToRule
// ---------------------------------------------------------------------------------------------------------------

test('#11 customToRule round-trips the UI examples and fires on a real subject', () => {
  const examples: CustomRule[] = [
    GOOD_CUSTOM,
    {
      id: 'USR-no-wet-over-gear', title: 'No wet services over switchgear',
      subject: { kind: 'element', elementKind: ['waste', 'storm', 'dcw', 'dhw'] },
      predicate: 'notOver', object: { kind: 'elementKind', value: 'switchgear' },
      limit: { op: '==', value: true }, severity: 'violation', source: 'NEC 2023 110.26(E)(1)(b)',
    },
    {
      id: 'USR-kitchen-adj-dining', title: 'Kitchens open onto the dining space',
      subject: { kind: 'room', roomType: ['kitchen'] },
      predicate: 'adjacent', object: { kind: 'roomType', value: 'dining' },
      limit: { op: '==', value: true }, severity: 'deviation',
    },
    {
      id: 'USR-corridor-45', title: 'Corridor legs under 40 m',
      subject: { kind: 'corridor' }, predicate: 'maxRun',
      limit: { op: '<=', value: 40, unit: 'm' }, severity: 'violation', resolution: 'split-corridor',
    },
    {
      id: 'USR-unit-min-area', title: 'No dwelling below 37 m²',
      subject: { kind: 'unit', templateId: ['studio', 'micro-studio'] }, predicate: 'minArea',
      limit: { op: '>=', value: 37, unit: 'm²' }, severity: 'violation',
    },
  ];
  for (const c of examples) {
    const { overrides, issues } = validateRuleOverrides({ version: 1, custom: [c] });
    assert.deepEqual(issues, [], `${c.id} should validate`);
    const rule = customToRule((overrides?.custom ?? [])[0]);
    assert.equal(rule.id, c.id);
    assert.equal(rule.kind, 'constraint');
    assert.equal(rule.subject, c.subject.kind);
    assert.equal(rule.predicate?.id, c.predicate);
    assert.equal(rule.params.limit.value, c.limit.value);
    assert.equal(rule.params.op.value, c.limit.op);
    assert.equal(rule.severity, c.severity ?? 'violation');
    if (c.object && c.object.kind !== 'none') assert.equal(rule.predicate?.args[0], c.object.value);
    if (c.subject.kind === 'room') assert.deepEqual(rule.scope.roomType, c.subject.roomType);
    if (c.subject.kind === 'unit') assert.deepEqual(rule.scope.templateIds, c.subject.templateId);
  }

  // The rule reaches the set, is scoped, and its predicate actually evaluates.
  const { rules } = set({ version: 1, custom: [GOOD_CUSTOM] });
  const rule = rules.get('USR-bed-min-width') as Rule;
  assert.ok(rule, 'the custom rule is in the set');
  assert.ok(rules.forSubject('room', { roomType: 'bedroom', floorUse: 'residential' }).some(r => r.id === rule.id));
  assert.equal(rules.forSubject('room', { roomType: 'kitchen', floorUse: 'residential' }).some(r => r.id === rule.id), false);

  const narrow = {
    id: 'R1', storey: 'L02', type: 'bedroom' as const, name: 'Bedroom', polygon: [], area: 9,
    rect: { x: 0, y: 0, w: 2.4, h: 3.75 }, height: 2.5, isWet: false, hasExterior: true,
    exteriorWallIds: [], wallIds: [], doorIds: [], windowIds: ['W1'], furnitureIds: [], occupancy: 2, zone: 'private' as const,
  };
  const world = {
    spec: SPEC, typology: TYPOLOGY, storeys: [], site: {}, arch: null, struct: null, mech: null, plumb: null, elec: null,
    presize: null, kernel: null, graph: buildRoomGraph({ walls: [], doors: [] }), invert: null,
    elementById: new Map(), roomById: new Map([[narrow.id, narrow]]),
  } as unknown as Parameters<typeof PREDICATES.minDim>[0];
  const failed = PREDICATES.minDim(world, rule, { kind: 'room', room: narrow });
  assert.equal(failed.ok, false, 'a 2.4 m bedroom fails a 2.7 m custom minimum');
  assert.equal(failed.observed, 2.4);
  assert.equal(failed.limit, 2.7);
  const wide = { ...narrow, rect: { x: 0, y: 0, w: 3.0, h: 3.0 } };
  assert.equal(PREDICATES.minDim(world, rule, { kind: 'room', room: wide }).ok, true);
});

// ---------------------------------------------------------------------------------------------------------------
// #12 — the ledger
// ---------------------------------------------------------------------------------------------------------------

test('#12 the ledger preserves the legacy strings, hides info, dedupes and counts', () => {
  const warnings: string[] = [];
  const ledger = createLedger({ mirrorInto: warnings });

  ledger.add({ severity: 'violation', ruleId: 'X', discipline: 'plumbing', message: 'kitchen had no sink in the furniture; synthesised one on the wet wall' });
  ledger.add({ severity: 'deviation', ruleId: 'Y', discipline: 'architecture', message: 'unit U-L02-06: En-suite: door narrowed to 0.60 m' });
  ledger.add({ severity: 'info', ruleId: 'Z', discipline: 'mechanical', message: 'a resolution was applied' });
  ledger.add({ severity: 'violation', ruleId: 'S', discipline: 'site', message: 'Parking: 85 spaces required, 57 achieved.' });
  ledger.add({ severity: 'error', ruleId: 'P', discipline: 'xd', message: 'Duplicate element id ARC-L02-WALL-001' });

  assert.deepEqual(warnings, [
    '[plumbing] kitchen had no sink in the furniture; synthesised one on the wet wall',
    '[architecture] unit U-L02-06: En-suite: door narrowed to 0.60 m',
    'Parking: 85 spaces required, 57 achieved.',
    'Duplicate element id ARC-L02-WALL-001',
  ], 'v1 prefixed architecture/structure/plumbing and left site and the pipeline bare');
  assert.deepEqual(ledger.warnings(), warnings, 'warnings() is the mirrored array');
  assert.equal(ledger.warnings({ includeInfo: true }).length, warnings.length + 1);
  assert.equal(warningString({ discipline: 'structure', message: 'x' }), '[structure] x');

  assert.deepEqual(ledger.counts(), { info: 1, deviation: 1, violation: 2, error: 1 });
  assert.equal(ledger.bySeverity('violation').length, 2);
  assert.equal(ledger.byRule('X').length, 1);
  assert.equal(ledger.all()[0].id, 'ISS-0001');
  assert.equal(ledger.all()[4].id, 'ISS-0005');

  // addOnce dedupes by key and counts
  const first = ledger.addOnce('k', { severity: 'violation', ruleId: 'D', discipline: 'plumbing', message: 'trap arm too long' });
  assert.ok(first);
  assert.equal(ledger.addOnce('k', { severity: 'violation', ruleId: 'D', discipline: 'plumbing', message: 'trap arm too long' }), null);
  assert.equal(ledger.addOnce('k', { severity: 'violation', ruleId: 'D', discipline: 'plumbing', message: 'trap arm too long' }), null);
  assert.equal(first.count, 3, 'the first issue carries the count');
  assert.equal(ledger.byRule('D').length, 1, 'the duplicates are not stored');
  assert.equal(warnings.filter(w => w.includes('trap arm')).length, 1, 'and only one string is mirrored');

  // mirroring can be suspended for the cross-discipline validators (removed with `warnings` in wave 3)
  const before = warnings.length;
  const was = ledger.mirroring(false);
  ledger.add({ severity: 'violation', ruleId: 'V', discipline: 'plumbing', message: 'post-check finding' });
  assert.equal(warnings.length, before, 'a suspended issue is recorded but not mirrored');
  assert.equal(ledger.byRule('V').length, 1);
  ledger.mirroring(was);
  ledger.add({ severity: 'violation', ruleId: 'V2', discipline: 'plumbing', message: 'mirrored again' });
  assert.equal(warnings.length, before + 1);

  // without a mirror the projection is derived from the issues
  const plain = createLedger();
  plain.add({ severity: 'info', ruleId: 'A', discipline: 'site', message: 'i' });
  plain.add({ severity: 'violation', ruleId: 'B', discipline: 'site', message: 'v' });
  assert.deepEqual(plain.warnings(), ['v']);
  assert.deepEqual(plain.warnings({ includeInfo: true }), ['i', 'v']);
});

// ---------------------------------------------------------------------------------------------------------------
// #13 — determinism
// ---------------------------------------------------------------------------------------------------------------

test('#13 the resolved rule set is independent of override key order', () => {
  const a: RuleOverrides = {
    version: 1,
    params: { 'ARC-03.maxLegLength': { value: 40 }, 'XD-02.crossingPitch': { value: 0.35 } },
    disabled: ['ARC-C6.corridorDeadEnd', 'ARC-C5.corridorLeg'],
    profiles: ['sprinklered', 'high-rise'],
    custom: [GOOD_CUSTOM, { ...GOOD_CUSTOM, id: 'USR-second', title: 'Another' }],
  };
  const b: RuleOverrides = {
    version: 1,
    params: { 'XD-02.crossingPitch': { value: 0.35 }, 'ARC-03.maxLegLength': { value: 40 } },
    disabled: ['ARC-C5.corridorLeg', 'ARC-C6.corridorDeadEnd'],
    profiles: ['high-rise', 'sprinklered'],
    custom: [{ ...GOOD_CUSTOM, id: 'USR-second', title: 'Another' }, GOOD_CUSTOM],
  };
  const ra = set(a).rules;
  const rb = set(b).rules;
  assert.deepEqual(ra.all().map(r => r.id), rb.all().map(r => r.id));
  assert.equal(JSON.stringify(ra.all()), JSON.stringify(rb.all()));
  assert.equal(ra.hash(), rb.hash(), 'the hash is a function of the resolved set, not of the input order');

  const ids = ra.all().map(r => r.id);
  assert.deepEqual(ids, [...ids].sort(), 'rules are in canonical id order');
  assert.equal(new Set(ids).size, ids.length, 'no duplicate ids');

  // The hash changes when a value changes, and is stable across two identical resolutions.
  assert.notEqual(set(a).rules.hash(), set().rules.hash());
  assert.equal(set().rules.hash(), set().rules.hash());
  assert.match(set().rules.hash(), /^[0-9a-f]{8}$/);
});

test('#13b scope matching rejects a context that cannot answer the facet', () => {
  assert.equal(scopeMatches({}, {}), true);
  assert.equal(scopeMatches({ roomType: ['bedroom'] }, {}), false, 'a room rule does not fire on a subject with no room type');
  assert.equal(scopeMatches({ roomType: ['bedroom'] }, { roomType: 'bedroom' }), true);
  assert.equal(scopeMatches({ roomType: ['bedroom'] }, { roomType: 'kitchen' }), false);
  assert.equal(scopeMatches({ storeyIndexMin: 1 }, { storeyIndex: 0 }), false);
  assert.equal(scopeMatches({ storeyIndexMin: 1 }, { storeyIndex: 4 }), true);
  assert.equal(scopeMatches({ sprinklered: true }, { sprinklered: false }), false);
  assert.equal(scopeMatches({ regions: ['UK', 'IE'] }, { region: 'IE' }), true);
  assert.equal(scopeMatches({ elementKinds: ['duct'] }, { elementKind: 'waste' }), false);
});

test('#13c the room graph answers adjacency, connectivity and through-routes deterministically', () => {
  const graph = buildRoomGraph({
    walls: [
      { id: 'W1', leftRoomId: 'hall', rightRoomId: 'bath' },
      { id: 'W2', leftRoomId: 'hall', rightRoomId: 'bed' },
      { id: 'W3', leftRoomId: 'bed', rightRoomId: 'balcony' },
      { id: 'W4', leftRoomId: 'entry', rightRoomId: 'hall' },
    ] as never,
    doors: [
      { id: 'D1', fromRoomId: 'entry', toRoomId: 'hall' },
      { id: 'D2', fromRoomId: 'hall', toRoomId: 'bed' },
      { id: 'D3', fromRoomId: 'bed', toRoomId: 'balcony' },
      { id: 'D4', fromRoomId: 'hall', toRoomId: 'bath' },
    ] as never,
  });
  assert.deepEqual(graph.adjacent('hall'), ['bath', 'bed', 'entry']);
  assert.deepEqual(graph.connected('bed'), ['balcony', 'hall']);
  assert.deepEqual(graph.path('entry', 'balcony'), ['entry', 'hall', 'bed', 'balcony']);
  assert.deepEqual(graph.through('entry', 'balcony'), ['hall', 'bed'], 'the balcony is reached through the bedroom');
  assert.deepEqual(graph.through('entry', 'bath'), ['hall']);
  assert.equal(graph.path('entry', 'nowhere'), null);
  assert.deepEqual(graph.adjacent('nowhere'), []);
});
