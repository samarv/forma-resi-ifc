import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateStep } from './validate.ts';

/** Smallest file that satisfies every structural rule. */
function tinyValidFile(dataLines: string[] = []): string {
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');",
    "FILE_NAME('tiny.ifc','2024-01-01T12:00:00',('tester'),('forma-resi-ifc'),'ifc-lite','ifc-lite','');",
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
    "#1=IFCPERSON($,$,'Tester',$,$,$,$,$);",
    "#2=IFCORGANIZATION($,'forma-resi-ifc',$,$,$);",
    '#3=IFCPERSONANDORGANIZATION(#1,#2,$);',
    "#4=IFCAPPLICATION(#2,'1.0','forma-resi-ifc','forma');",
    '#5=IFCOWNERHISTORY(#3,#4,$,.NOCHANGE.,$,$,$,1704110400);',
    '#6=IFCCARTESIANPOINT((0.,0.,0.));',
    '#7=IFCDIRECTION((0.,0.,1.));',
    '#8=IFCDIRECTION((1.,0.,0.));',
    '#9=IFCAXIS2PLACEMENT3D(#6,#7,#8);',
    '#10=IFCLOCALPLACEMENT($,#9);',
    "#11=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,0.00001,#9,$);",
    '#12=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
    '#13=IFCUNITASSIGNMENT((#12));',
    "#14=IFCPROJECT('0000000000000000000001',#5,'Tiny','It''s tiny',$,$,$,(#11),#13);",
    "#15=IFCSITE('0000000000000000000002',#5,'Site',$,$,#10,$,$,.ELEMENT.,$,$,$,$,$);",
    "#16=IFCBUILDING('0000000000000000000003',#5,'Building',$,$,#10,$,$,.ELEMENT.,$,$,$);",
    "#17=IFCBUILDINGSTOREY('0000000000000000000004',#5,'Level 1',$,$,#10,$,$,.ELEMENT.,0.);",
    "#18=IFCWALL('0000000000000000000005',#5,'Wall',$,$,#10,$,'W-1',.STANDARD.);",
    "#19=IFCRELAGGREGATES('0000000000000000000006',#5,$,$,#14,(#15));",
    "#20=IFCRELAGGREGATES('0000000000000000000007',#5,$,$,#15,(#16));",
    "#21=IFCRELAGGREGATES('0000000000000000000008',#5,$,$,#16,(#17));",
    "#22=IFCRELCONTAINEDINSPATIALSTRUCTURE('0000000000000000000009',#5,$,$,(#18),#17);",
    ...dataLines,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}

test('a hand-written tiny STEP file passes', () => {
  const result = validateStep(tinyValidFile());
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.equal(result.schema, 'IFC4');
  assert.equal(result.entityCount, 22);
  assert.equal(result.unresolvedRefs, 0);
  assert.equal(result.byType.IFCWALL, 1);
  assert.equal(result.byType.IFCRELAGGREGATES, 3);
  assert.deepEqual(result.warnings, []);
});

test('broken references are reported and counted', () => {
  const result = validateStep(tinyValidFile(["#23=IFCRELVOIDSELEMENT('000000000000000000000A',#5,$,$,#18,#999);"]));
  assert.equal(result.ok, false);
  assert.equal(result.unresolvedRefs, 1);
  assert.ok(result.errors.some(e => e.includes('unresolved reference #999')), result.errors.join('\n'));
});

test('duplicate express ids fail', () => {
  const result = validateStep(tinyValidFile(["#18=IFCWALL('000000000000000000000B',#5,'Clone',$,$,#10,$,'W-2',.STANDARD.);"]));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.includes('duplicate express id #18')), result.errors.join('\n'));
});

test('exponent literals fail with a clear message', () => {
  const result = validateStep(tinyValidFile(['#23=IFCCARTESIANPOINT((1e-7,0.,0.));']));
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some(e => e.includes("exponent literal '1e-7'") && e.includes('plain decimals')),
    result.errors.join('\n'),
  );
  assert.equal(validateStep(tinyValidFile(['#23=IFCCARTESIANPOINT((1.0E-5,0.,0.));'])).ok, false);
  assert.equal(validateStep(tinyValidFile(['#23=IFCCARTESIANPOINT((0.0000001,0.,0.));'])).ok, true);
});

test('NaN and Infinity fail', () => {
  for (const literal of ['NaN', 'Infinity', '-Infinity', 'inf']) {
    const result = validateStep(tinyValidFile([`#23=IFCCARTESIANPOINT((${literal},0.,0.));`]));
    assert.equal(result.ok, false, `${literal} should be rejected`);
    assert.ok(result.errors.some(e => e.includes('not a valid STEP')), `${literal}: ${result.errors.join('\n')}`);
  }
});

test('unbalanced parentheses and malformed lines fail', () => {
  const unbalanced = validateStep(tinyValidFile(['#23=IFCCARTESIANPOINT((1.,0.,0.);']));
  assert.equal(unbalanced.ok, false);
  assert.ok(unbalanced.errors.some(e => e.includes('unbalanced parentheses')), unbalanced.errors.join('\n'));

  const noSemicolon = validateStep(tinyValidFile(['#23=IFCDIRECTION((1.,0.,0.))']));
  assert.equal(noSemicolon.ok, false);
  assert.ok(noSemicolon.errors.some(e => e.includes("does not end with ';'")), noSemicolon.errors.join('\n'));

  const noHash = validateStep(tinyValidFile(['IFCDIRECTION((1.,0.,0.));']));
  assert.equal(noHash.ok, false);
  assert.ok(noHash.errors.some(e => e.includes("does not start with '#'")), noHash.errors.join('\n'));

  const badId = validateStep(tinyValidFile(['#2a=IFCDIRECTION((1.,0.,0.));']));
  assert.equal(badId.ok, false);
  assert.ok(badId.errors.some(e => e.includes('not an integer')), badId.errors.join('\n'));

  const unterminated = validateStep(tinyValidFile(["#23=IFCORGANIZATION($,'oops,$,$,$);"]));
  assert.equal(unterminated.ok, false);
  assert.ok(unterminated.errors.some(e => e.includes('unterminated string')), unterminated.errors.join('\n'));
});

test('quoted strings may contain parentheses, hashes and escaped quotes', () => {
  const result = validateStep(tinyValidFile([
    "#23=IFCORGANIZATION($,'A (tricky) name with #42 and an ''escaped'' quote',$,$,$);",
  ]));
  assert.deepEqual(result.errors, []);
  assert.equal(result.unresolvedRefs, 0);
});

test('header problems fail early with a precise message', () => {
  assert.ok(validateStep('').errors[0].includes('empty content'));
  assert.ok(validateStep('nope').errors[0].includes('ISO-10303-21'));
  assert.ok(validateStep('ISO-10303-21;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n').errors[0].includes('HEADER'));

  const noSchema = tinyValidFile().replace("FILE_SCHEMA(('IFC4'));", '');
  assert.ok(validateStep(noSchema).errors[0].includes('FILE_SCHEMA'));

  const noData = tinyValidFile().replace('DATA;', '');
  assert.ok(validateStep(noData).errors[0].includes('DATA'));

  const noTerminator = tinyValidFile().replace('END-ISO-10303-21;', '');
  assert.ok(validateStep(noTerminator).errors[0].includes('END-ISO-10303-21'));
});

test('missing spatial structure entities fail', () => {
  const noProject = tinyValidFile().replace(/#14=IFCPROJECT[^\n]*\n/, '');
  const result = validateStep(noProject);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.includes('expected exactly 1 IFCPROJECT, found 0')), result.errors.join('\n'));

  const twoProjects = tinyValidFile(["#23=IFCPROJECT('000000000000000000000C',#5,'Second',$,$,$,$,(#11),#13);"]);
  assert.ok(validateStep(twoProjects).errors.some(e => e.includes('expected exactly 1 IFCPROJECT, found 2')));

  const noStorey = tinyValidFile().replace(/#17=IFCBUILDINGSTOREY[^\n]*\n/, '').replace(/#21=IFCRELAGGREGATES[^\n]*\n/, '').replace(/#22=IFCRELCONTAINED[^\n]*\n/, '');
  assert.ok(validateStep(noStorey).errors.some(e => e.includes('expected at least 1 IFCBUILDINGSTOREY')));
});

test('an empty relationship member list fails', () => {
  const empty = validateStep(tinyValidFile(["#23=IFCRELCONTAINEDINSPATIALSTRUCTURE('000000000000000000000D',#5,$,$,(),#17);"]));
  assert.equal(empty.ok, false);
  assert.ok(empty.errors.some(e => e.includes('IFCRELCONTAINEDINSPATIALSTRUCTURE needs at least one element')), empty.errors.join('\n'));

  const noRelating = validateStep(tinyValidFile(["#23=IFCRELASSIGNSTOGROUP('000000000000000000000E',#5,$,$,(#18),$,$);"]));
  assert.equal(noRelating.ok, false);
  assert.ok(noRelating.errors.some(e => e.includes('IFCRELASSIGNSTOGROUP needs at least one element and a relating object')), noRelating.errors.join('\n'));
});

test('IfcRelDefinesByType is checked like the other member-list relationships', () => {
  // RelatedObjects is the member set and RelatingType is the last attribute, so
  // the existing rule fits the layout exactly.
  const ok = validateStep(tinyValidFile([
    "#23=IFCFURNITURETYPE('000000000000000000000F',#5,'Bed Queen',$,$,$,$,'FT-bed-queen','bed-queen',$,.BED.);",
    "#24=IFCFURNISHINGELEMENT('000000000000000000000G',#5,'Bed Queen',$,'bed-queen',#10,$,'ARC-L01-FURN-001');",
    "#25=IFCRELDEFINESBYTYPE('000000000000000000000H',#5,$,$,(#24),#23);",
  ]));
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.byType.IFCRELDEFINESBYTYPE, 1);

  const empty = validateStep(tinyValidFile([
    "#23=IFCFURNITURETYPE('000000000000000000000F',#5,'Bed Queen',$,$,$,$,'FT-bed-queen','bed-queen',$,.BED.);",
    "#24=IFCRELDEFINESBYTYPE('000000000000000000000H',#5,$,$,(),#23);",
  ]));
  assert.equal(empty.ok, false);
  assert.ok(empty.errors.some(e => e.includes('IFCRELDEFINESBYTYPE needs at least one element')), empty.errors.join('\n'));

  const noType = validateStep(tinyValidFile([
    "#23=IFCFURNISHINGELEMENT('000000000000000000000G',#5,'Bed Queen',$,'bed-queen',#10,$,'ARC-L01-FURN-001');",
    "#24=IFCRELDEFINESBYTYPE('000000000000000000000H',#5,$,$,(#23),$);",
  ]));
  assert.equal(noType.ok, false);
  assert.ok(noType.errors.some(e => e.includes('IFCRELDEFINESBYTYPE needs at least one element and a relating object')), noType.errors.join('\n'));
});

test('error reporting is capped', () => {
  const extra: string[] = [];
  for (let i = 0; i < 200; i++) extra.push(`#${1000 + i}=IFCDIRECTION((1.,0.,#${500000 + i}));`);
  const result = validateStep(tinyValidFile(extra));
  assert.equal(result.ok, false);
  assert.equal(result.unresolvedRefs, 200);
  assert.equal(result.errors.length, 51, '50 reported + 1 overflow note');
  assert.ok(result.errors[50].includes('further errors suppressed'));
});

test('a 30 MB file validates in under 2 s', () => {
  const lines: string[] = [];
  let id = 23;
  // ~680k entities ≈ 30 MB of STEP text.
  while (lines.length < 680_000) {
    lines.push(`#${id}=IFCCARTESIANPOINT((${(id % 97) + 0.125},${(id % 31) + 0.5},0.));`);
    id += 1;
  }
  const content = tinyValidFile(lines);
  assert.ok(content.length > 30_000_000, `fixture is only ${(content.length / 1e6).toFixed(1)} MB`);

  const t0 = performance.now();
  const result = validateStep(content);
  const ms = performance.now() - t0;

  assert.deepEqual(result.errors, []);
  assert.equal(result.entityCount, 680_022);
  assert.ok(ms < 2000, `validateStep took ${ms.toFixed(0)} ms on ${(content.length / 1e6).toFixed(1)} MB`);
});
