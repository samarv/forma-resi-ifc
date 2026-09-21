/**
 * Site discipline tests: every preset must produce a valid site model, and the presets that
 * exercise a specific rule (courtyard, podium tower, corridor mid-rise, house, terrace) must
 * produce the form that rule describes.
 *
 * Run: node --test src/disciplines/site/*.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PRESETS, normalizeSpec, type Preset, type PartialSpec } from '../../core/spec.ts';
import { getTypology, TYPOLOGIES, TYPOLOGY_IDS } from '../../core/typologies.ts';
import { createRng } from '../../core/rng.ts';
import { CROSS_PATTERNS } from '../../core/patterns.ts';
import { polygonBounds, polygonArea, rectContainsRect, rectsOverlap } from '../../core/geometry.ts';
import type { SiteModel, BuildingSpec, TypologyDef, Rect, SiteGenerator, MassingBar, CorridorSpine } from '../../core/types.ts';
import type { Deviation, Issue, Ledger } from '../../core/rules/types.ts';
import { UNIT_TEMPLATES } from '../architecture/templates.ts';
import { generateSite, SITE_PATTERNS } from './index.ts';
import { CORE_WIDTH_ALONG_BAR, CORE_SHAFT_BAY, coreAcrossFor, stairRunFor } from './massing.ts';
import { legGraph } from './corridor-graph.ts';
import { collectNumbers } from './util.ts';

/** Compile-time conformance to the contract in core/types.ts */
const gen: SiteGenerator = generateSite;

interface Built { spec: BuildingSpec; typology: TypologyDef; site: SiteModel; warnings: string[]; ms: number }

function build(preset: Preset): Built {
  return buildSpec(preset.spec);
}

function buildSpec(partial: PartialSpec): Built {
  const spec = normalizeSpec(partial);
  const typology = getTypology(spec.typology);
  const warnings: string[] = [];
  const t0 = performance.now();
  const site = gen(spec, typology, createRng(spec.seed).fork('site'), warnings);
  return { spec, typology, site, warnings, ms: performance.now() - t0 };
}

function preset(id: string): Preset {
  const p = PRESETS.find(x => x.id === id);
  if (!p) throw new Error(`no preset ${id}`);
  return p;
}

/** Long dimension of a core rect along its bar, and the short one across it */
function coreAlongAcross(core: { rect: Rect }, bar: MassingBar): { along: number; across: number } {
  return bar.axis === 'x'
    ? { along: core.rect.w, across: core.rect.h }
    : { along: core.rect.h, across: core.rect.w };
}

/** Distance from a corridor centreline to the nearer long face of its bar */
function spineToFace(spine: CorridorSpine, bar: MassingBar): number {
  const across = bar.axis === 'x'
    ? (spine.centerline.a[1] + spine.centerline.b[1]) / 2 - bar.rect.y
    : (spine.centerline.a[0] + spine.centerline.b[0]) / 2 - bar.rect.x;
  return Math.min(across, bar.depth - across);
}

/** Warnings that mean the generator produced broken geometry (as opposed to a design report) */
const HARD_WARNING = /falls outside|overlap|Duplicate|non-finite|not contained|unknown bar|missing SITE/i;

function boundaryRect(site: SiteModel): Rect {
  return polygonBounds(site.boundary);
}

// ---------------------------------------------------------------------------
// Pattern book
// ---------------------------------------------------------------------------

test('pattern book covers SIT-01..SIT-10 and every id the typologies reference', () => {
  const ids = new Set(SITE_PATTERNS.map(p => p.id));
  for (let i = 1; i <= 10; i++) {
    assert.ok(ids.has(`SIT-${String(i).padStart(2, '0')}`), `missing SIT-${i}`);
  }
  for (const tid of TYPOLOGY_IDS) {
    for (const pid of TYPOLOGIES[tid].patterns) {
      if (pid.startsWith('SIT-')) assert.ok(ids.has(pid), `${tid} references unimplemented ${pid}`);
    }
  }
  assert.equal(ids.size, SITE_PATTERNS.length, 'duplicate pattern ids');
  for (const p of SITE_PATTERNS) {
    assert.equal(p.discipline, 'site');
    assert.ok(p.problem.length > 60, `${p.id} problem too thin`);
    assert.ok(p.solution.length > 60, `${p.id} solution too thin`);
    assert.ok(Object.keys(p.parameters).length > 0, `${p.id} has no parameters`);
    for (const key of Object.keys(p.parameters)) {
      const param = p.parameters[key];
      assert.ok(param.unit !== undefined || param.source !== undefined, `${p.id}.${key} has neither unit nor source`);
    }
  }
});

// ---------------------------------------------------------------------------
// Every preset
// ---------------------------------------------------------------------------

for (const preset of PRESETS) {
  test(`preset ${preset.id}: valid site model`, () => {
    const { spec, typology, site, warnings } = build(preset);
    const B = boundaryRect(site);

    // --- basics ------------------------------------------------------------
    assert.ok(site.elements.length > 0, 'no elements emitted');
    assert.ok(site.massing.storeys.length >= 3, 'storey stack too short');
    assert.deepEqual(site.massing.storeys.slice(0, 2).map(s => s.id), ['SITE', 'FND']);
    assert.equal(site.massing.storeys[site.massing.storeys.length - 1].id, 'ROOF');
    assert.equal(site.area, spec.site.width * spec.site.depth);
    assert.equal(site.setbacks.front >= 0 && site.setbacks.side >= 0 && site.setbacks.rear >= 0, true);

    // --- no broken geometry ------------------------------------------------
    const hard = warnings.filter(w => HARD_WARNING.test(w));
    assert.deepEqual(hard, [], `hard warnings: ${hard.join(' | ')}`);
    for (const e of site.elements) {
      assert.ok(collectNumbers(e.geometry).every(Number.isFinite), `${e.id} has non-finite geometry`);
      assert.equal(e.discipline, 'site');
      assert.ok(e.ifcType.startsWith('Ifc'), `${e.id} ifcType ${e.ifcType}`);
      assert.ok(e.psets && e.psets.some(p => p.name === 'Forma_Site'), `${e.id} missing Forma_Site pset`);
      assert.ok(site.massing.storeys.some(s => s.id === e.storey), `${e.id} on unknown storey ${e.storey}`);
      if (e.color) assert.ok(e.color.every(c => c >= 0 && c <= 1), `${e.id} colour out of range`);
    }

    // --- unique ids --------------------------------------------------------
    const ids = [
      ...site.elements.map(e => e.id), ...site.massing.bars.map(b => b.id),
      ...site.massing.cores.map(c => c.id), ...site.massing.corridors.map(c => c.id),
      ...site.entrances.map(e => e.id), ...site.landscape.map(z => z.id),
      ...(site.parking ? site.parking.spaces.map(s => s.id) : []),
    ];
    assert.equal(new Set(ids).size, ids.length, 'duplicate ids');

    // --- footprint inside the boundary, bars disjoint, cores inside bars ---
    for (const p of site.massing.footprint) {
      assert.ok(p[0] >= B.x - 1e-3 && p[0] <= B.x + B.w + 1e-3, 'footprint x outside boundary');
      assert.ok(p[1] >= B.y - 1e-3 && p[1] <= B.y + B.h + 1e-3, 'footprint y outside boundary');
    }
    assert.ok(site.massing.bars.length > 0, 'no bars');
    for (let i = 0; i < site.massing.bars.length; i++) {
      const bar = site.massing.bars[i];
      assert.ok(rectContainsRect(B, bar.rect, 1e-3), `${bar.id} outside boundary`);
      assert.ok(bar.length >= bar.depth - 1e-6, `${bar.id} length < depth`);
      assert.ok(bar.exteriorSides.length > 0, `${bar.id} has no exterior side`);
      for (let j = i + 1; j < site.massing.bars.length; j++) {
        assert.equal(rectsOverlap(bar.rect, site.massing.bars[j].rect, 1e-4), false, 'bars overlap');
      }
    }
    const barById = new Map(site.massing.bars.map(b => [b.id, b]));
    for (const core of site.massing.cores) {
      const bar = barById.get(core.barId);
      assert.ok(bar, `core ${core.id} has no bar`);
      assert.ok(rectContainsRect(bar.rect, core.rect, 1e-3), `core ${core.id} escapes its bar`);
      assert.ok(core.rect.w > 1 && core.rect.h > 1, `core ${core.id} degenerate`);
      if (core.hasElevator) assert.ok(core.elevatorCount >= 1);
    }
    for (const corridor of site.massing.corridors) {
      const bar = barById.get(corridor.barId);
      assert.ok(bar, `corridor ${corridor.id} has no bar`);
      assert.ok(corridor.width > 0.9 && corridor.width < 4);
      assert.ok(rectContainsRect(bar.rect, {
        x: Math.min(corridor.centerline.a[0], corridor.centerline.b[0]),
        y: Math.min(corridor.centerline.a[1], corridor.centerline.b[1]),
        w: Math.abs(corridor.centerline.b[0] - corridor.centerline.a[0]),
        h: Math.abs(corridor.centerline.b[1] - corridor.centerline.a[1]),
      }, 1e-3), `corridor ${corridor.id} escapes its bar`);
    }

    // --- parking -----------------------------------------------------------
    assert.ok(site.parking, 'parking lot object missing');
    const lot = site.parking;
    for (const s of lot.spaces) {
      assert.ok(rectContainsRect(B, s.rect, 0.05), `${s.id} outside the site`);
      assert.ok(s.rect.w > 1.5 && s.rect.h > 1.5, `${s.id} degenerate`);
      assert.ok(site.massing.storeys.some(st => st.id === s.storey), `${s.id} on unknown storey ${s.storey}`);
      assert.ok(Number.isFinite(s.rotation));
    }
    if (lot.type === 'underground') assert.ok(lot.storey.startsWith('B'), `underground parking on ${lot.storey}`);
    if (lot.type === 'surface' || lot.type === 'garage-attached') assert.equal(lot.storey, 'SITE');
    assert.ok(lot.bikeSpaces >= 0);

    // --- landscape and paths ----------------------------------------------
    for (const z of site.landscape) {
      assert.ok(z.area > 0, `zone ${z.id} has no area`);
      assert.ok(Math.abs(polygonArea(z.polygon) - z.area) < 1e-6, `zone ${z.id} area mismatch`);
      for (const p of z.polygon) {
        assert.ok(p[0] >= B.x - 1 && p[0] <= B.x + B.w + 1, `zone ${z.id} x outside site`);
        assert.ok(p[1] >= B.y - 1 && p[1] <= B.y + B.h + 1, `zone ${z.id} y outside site`);
      }
    }
    for (const p of site.paths) assert.ok(p.w > 1 && p.h > 0, 'degenerate path');

    // --- entrances ---------------------------------------------------------
    assert.ok(site.entrances.length > 0, 'no entrances');
    for (const e of site.entrances) {
      assert.ok(e.position.every(Number.isFinite));
      assert.ok(e.position[0] >= -1 && e.position[0] <= B.w + 1, 'entrance off site');
      assert.ok(e.position[1] >= -1 && e.position[1] <= B.h + 1, 'entrance off site');
    }
    const unitEntrances = site.entrances.filter(e => e.type === 'unit');
    for (let i = 1; i < unitEntrances.length; i++) {
      assert.ok(unitEntrances[i].position[0] >= unitEntrances[i - 1].position[0] - 1e-9, 'unit entrances not ordered along +X');
    }
    if (typology.access !== 'direct') {
      assert.ok(site.entrances.some(e => e.type === 'main'), 'no main entrance');
    }

    // --- derived -----------------------------------------------------------
    for (const key of Object.keys(site.derived)) {
      assert.ok(Number.isFinite(site.derived[key]), `derived.${key} = ${site.derived[key]}`);
    }
    const d = site.derived;
    for (const key of ['siteArea', 'buildableArea', 'footprintArea', 'gfa', 'far', 'coverage', 'openSpaceArea',
      'landscapeArea', 'landscapeRatio', 'parkingSpaces', 'evSpaces', 'accessibleSpaces', 'bikeSpaces',
      'estimatedUnits', 'densityDph', 'treeCount', 'heightAboveGrade', 'setbackFront', 'setbackSide',
      'setbackRear', 'coreCount', 'maxTravelDistance']) {
      assert.ok(key in d, `derived.${key} missing`);
    }
    assert.ok(d.coverage > 0 && d.coverage <= 1, `coverage ${d.coverage}`);
    assert.ok(d.far > 0, `far ${d.far}`);
    assert.ok(d.landscapeRatio >= 0 && d.landscapeRatio <= 1);
    assert.ok(d.gfa >= d.footprintArea - 1e-6, 'gfa below footprint');
    assert.ok(d.estimatedUnits >= 1, 'no units estimated');
    assert.ok(d.densityDph > 0);
    assert.ok(d.heightAboveGrade > 2 && d.heightAboveGrade < 400);
    assert.ok(d.coreCount === site.massing.cores.length);
    assert.ok(d.maxTravelDistance >= 0);
    assert.equal(d.siteArea, site.area);
    assert.ok(d.buildableArea <= d.siteArea + 1e-6);
    assert.ok(d.footprintArea <= d.siteArea + 1e-6);
    assert.ok(d.accessibleSpaces <= d.parkingSpaces && d.evSpaces <= d.parkingSpaces);

    // --- pattern trace -----------------------------------------------------
    // Site may also record the cross-discipline patterns it resolves (XD-04 shaft bay in the core).
    const known = new Set([...SITE_PATTERNS.map(p => p.id), ...CROSS_PATTERNS.map(p => p.id)]);
    assert.ok(site.patterns.length > 0, 'no pattern applications');
    for (const app of site.patterns) assert.ok(known.has(app.patternId), `unknown pattern ${app.patternId}`);
    for (const e of site.elements) {
      for (const pid of e.patterns ?? []) assert.ok(known.has(pid), `${e.id} cites unknown ${pid}`);
    }
    for (const required of ['SIT-01', 'SIT-02', 'SIT-07', 'SIT-08', 'SIT-09', 'SIT-10', 'SIT-11']) {
      assert.ok(site.patterns.some(a => a.patternId === required), `${required} never applied`);
    }
  });
}

test('generation is deterministic for a given seed', () => {
  for (const preset of PRESETS) {
    const a = build(preset);
    const b = build(preset);
    assert.equal(JSON.stringify(a.site), JSON.stringify(b.site), `${preset.id} not deterministic`);
    assert.deepEqual(a.warnings, b.warnings, `${preset.id} warnings not deterministic`);
  }
});

// ---------------------------------------------------------------------------
// Shape-specific expectations
// ---------------------------------------------------------------------------

test("ie-courtyard: perimeter block with a courtyard that lives (>= 15 m clear)", () => {
  const { site } = build(PRESETS.find(p => p.id === 'ie-courtyard')!);
  assert.equal(site.massing.shape, 'O');
  assert.equal(site.massing.bars.length, 4);
  assert.ok(site.massing.courtyard, 'no courtyard polygon');
  const c = polygonBounds(site.massing.courtyard!);
  assert.ok(Math.min(c.w, c.h) >= 15, `courtyard only ${Math.min(c.w, c.h).toFixed(1)} m clear`);
  assert.ok(site.landscape.some(z => z.type === 'courtyard'), 'no courtyard landscape zone');
  assert.ok(site.entrances.some(e => e.type === 'courtyard'), 'no courtyard passage');
  // Every bar of the ring keeps at least one exterior face, and the two side bars run in +Y.
  assert.equal(site.massing.bars.filter(b => b.axis === 'y').length, 2);
  assert.ok(site.derived.courtyardArea > 225);
  assert.ok(site.derived.coverage < 1, 'courtyard must not count as footprint');
  assert.equal(site.massing.corridors.length, 4);
});

test('ca-point-tower: podium + tower footprint, one central core', () => {
  const { site, spec } = build(PRESETS.find(p => p.id === 'ca-point-tower')!);
  assert.equal(site.massing.shape, 'point');
  assert.ok(site.massing.podium, 'no podium');
  assert.equal(site.massing.podium!.storeys, spec.massing.podiumStoreys);
  assert.ok(site.massing.towerFootprint, 'no towerFootprint');
  const podium = polygonBounds(site.massing.podium!.footprint);
  const tower = polygonBounds(site.massing.towerFootprint!);
  assert.ok(podium.w * podium.h > tower.w * tower.h, 'podium not larger than the tower');
  assert.ok(rectContainsRect(podium, tower, 1e-3), 'tower not over the podium');
  assert.equal(site.massing.cores.length, 1);
  const core = site.massing.cores[0];
  const plate = polygonBounds(site.massing.towerFootprint!);
  assert.ok(Math.abs(core.rect.x + core.rect.w / 2 - (plate.x + plate.w / 2)) < 1, 'core not centred in X');
  assert.ok(Math.abs(core.rect.y + core.rect.h / 2 - (plate.y + plate.h / 2)) < 1, 'core not centred in Y');
  assert.ok(core.elevatorCount >= 2 && core.elevatorCount <= 3, `lifts ${core.elevatorCount}`);
  assert.equal(core.type, 'scissor-stair', '22 storeys should get scissor stairs');
  // 9 × 7 m of stairs, lifts and lobby PLUS the 2.4 m service shaft bay on one long side.
  const big = core.rect.w >= 9.0 + CORE_SHAFT_BAY - 1e-6 && core.rect.h >= 7.0 - 1e-6;   // 11.4 × 7
  const deep = core.rect.w >= 9.0 - 1e-6 && core.rect.h >= 7.0 + CORE_SHAFT_BAY - 1e-6;  // 9 × 9.4
  assert.ok(big || deep, `point core ${core.rect.w} × ${core.rect.h} holds no 2.4 m shaft bay`);
  assert.ok(Math.min(core.rect.w, core.rect.h) >= stairRunFor(spec.massing.groundFloorToFloor!) - 1e-6,
    'point core too small for a dog-leg stair at this floor-to-floor');
  assert.equal(site.massing.corridors.length, 0, 'point plates leave the loop corridor to architecture');
});

test('us-5-over-1: two cores and a double-loaded corridor spine', () => {
  const { site, spec } = build(preset('us-5-over-1'));
  const needAcross = coreAcrossFor(Math.max(spec.massing.floorToFloor!, spec.massing.groundFloorToFloor!), true);
  assert.ok(site.massing.cores.length >= 2, `only ${site.massing.cores.length} cores`);
  assert.equal(site.massing.corridors.length, 1);
  const corridor = site.massing.corridors[0];
  assert.equal(corridor.loaded, 'both');
  const bar = site.massing.bars.find(b => b.id === corridor.barId)!;
  // Corridor on the bar centreline, running the full length of the bar.
  assert.ok(Math.abs(corridor.centerline.a[1] - (bar.rect.y + bar.rect.h / 2)) < 1e-6);
  assert.ok(Math.abs(corridor.centerline.b[0] - corridor.centerline.a[0] - bar.length) < 1e-6);
  // Cores flush against the corridor, never overlapping it, and clear of the bar ends.
  assert.ok(site.massing.cores.length >= 2, 'a 6-storey corridor block needs two exits');
  for (const core of site.massing.cores) {
    const top = corridor.centerline.a[1] - corridor.width / 2;
    const bottom = corridor.centerline.a[1] + corridor.width / 2;
    const clearsCorridor = core.rect.y + core.rect.h <= top + 1e-6 || core.rect.y >= bottom - 1e-6;
    assert.ok(clearsCorridor, 'core overlaps the corridor');
    assert.ok(core.rect.x - bar.rect.x >= 6 - core.rect.w / 2 - 1e-6, 'core too close to the bar start');
    assert.ok(bar.rect.x + bar.rect.w - (core.rect.x + core.rect.w) >= 6 - core.rect.w / 2 - 1e-6, 'core too close to the bar end');
    // 2.6 m stair bay + 2.4 m service shaft bay along the bar, one unit strip deep across it.
    const { along, across } = coreAlongAcross(core, bar);
    assert.ok(Math.abs(along - 5.0) < 1e-6, `core is ${along} m along the bar, not 5.0 m`);
    assert.ok(across >= needAcross - 1e-6 && across <= (bar.depth - corridor.width) / 2 + 1e-6,
      `core ${across} m across should hold a ${needAcross} m stair+lift+lobby and fit the ${((bar.depth - corridor.width) / 2).toFixed(2)} m unit strip`);
  }
  assert.ok(site.derived.maxTravelDistance <= site.derived.travelLimit, 'travel distance over the limit');
  // Podium parking on the ground floor, which spec.floors marks 'parking'.
  assert.equal(site.parking!.type, 'podium');
  assert.equal(site.parking!.storey, 'L01');
  assert.ok(site.parking!.spaces.length >= site.derived.parkingRequired);
  assert.ok(site.parking!.spaces.some(s => s.type === 'accessible'), 'no accessible stall');
  assert.ok(site.parking!.spaces.some(s => s.type === 'ev'), 'no EV stall');
});

test('us-detached: garage entrance, driveway and a private rear garden', () => {
  const { site } = build(PRESETS.find(p => p.id === 'us-detached')!);
  assert.ok(site.entrances.some(e => e.type === 'garage'), 'no garage entrance');
  assert.ok(site.entrances.some(e => e.type === 'main'), 'no main entrance');
  assert.ok(site.driveway, 'no driveway');
  assert.equal(site.massing.cores.length, 0, 'a house has no shared core');
  const rearY = Math.max(...site.massing.bars.map(b => b.rect.y + b.rect.h));
  const gardens = site.landscape.filter(z => z.type === 'private-garden');
  assert.ok(gardens.length >= 1, 'no private garden');
  assert.ok(
    gardens.some(z => z.polygon.every(p => p[1] >= rearY - 1e-6) && z.area > 20),
    'no usable garden behind the house',
  );
  // Two car spaces for a 2-space ratio, inside a garage bay beside the house.
  assert.equal(site.parking!.type, 'garage-attached');
  assert.equal(site.parking!.spaces.length, 2);
});

test("uk-terrace: 'unit' entrance count equals architecture's house count formula", () => {
  const { site, spec, typology } = build(preset('uk-terrace'));
  const bar = site.massing.bars[0];
  const units = site.entrances.filter(e => e.type === 'unit');

  // The formula floor-organizer.planHouses uses, restated here independently:
  //   netDepth = barDepth − 2 × 0.3 exterior walls
  //   minFrontage = frontage.min × clamp(depth.max / netDepth, 0.45, 1)
  //   frontage = clamp(area.target / (levels × netDepth), minFrontage, frontage.max)
  //   n = round(barLength / frontage)
  const template = UNIT_TEMPLATES['townhouse-3s'];
  assert.equal(Object.keys(typology.defaultUnitMix)[0], template.id, 'preset mix is no longer townhouse-3s');
  const netDepth = bar.depth - 0.6;
  const levels = template.storeysInUnit;
  assert.equal(levels, spec.massing.storeys, 'the terrace preset should be as tall as the template');
  const minF = template.frontage.min * Math.min(1, Math.max(0.45, template.depth.max / netDepth));
  const frontage = Math.min(template.frontage.max, Math.max(minF, template.area.target / (levels * netDepth)));
  const expected = Math.max(1, Math.round(bar.length / frontage));
  assert.equal(units.length, expected, `${units.length} unit entrances for a ${bar.length.toFixed(1)} m row (formula wants ${expected})`);
  assert.ok(expected === 6 || expected === 7, `${expected} houses on a ${bar.length.toFixed(1)} m bar`);
  assert.equal(site.derived.dwellingsAcross, expected, 'derived.dwellingsAcross out of step');
  // Garage-attached row: one garage door per house as well, both sets evenly spaced.
  const garages = site.entrances.filter(e => e.type === 'garage');
  assert.equal(garages.length, expected, 'one garage entrance per house');
  const spacing = bar.length / expected;
  for (let i = 1; i < units.length; i++) {
    assert.ok(Math.abs(units[i].position[0] - units[i - 1].position[0] - spacing) < 1e-6, 'unit doors not evenly spaced');
  }
  assert.equal(site.derived.dwellings, units.length);
  // Doors on the street face, in order, each with its own path.
  for (const e of units) {
    assert.equal(e.side, 'front');
    assert.ok(Math.abs(e.position[1] - bar.rect.y) < 1e-6, 'unit door not on the front face');
  }
  assert.ok(site.paths.length >= units.length - 1, 'missing front paths');
  assert.equal(site.massing.cores.length, 0);
  assert.ok(site.landscape.filter(z => z.type === 'private-garden').length >= 1);
  assert.equal(spec.massing.storeys, 3);
});

test('au-walkup: two or three stair cores, no corridor, no lift', () => {
  const { site, spec } = build(preset('au-walkup'));
  assert.equal(site.massing.corridors.length, 0, 'walk-ups have landings, not corridors');
  for (const core of site.massing.cores) {
    assert.equal(core.type, 'stair');
    assert.equal(core.hasElevator, false);
    assert.equal(core.elevatorCount, 0);
  }
  const n = site.massing.cores.length;
  assert.ok(n >= 2 && n <= 3, `${n} cores on a ${site.massing.bars[0].length.toFixed(1)} m walk-up bar`);
  // 5 units per floor is more than the 4 a single stair may serve (SIT-08), so never one core.
  assert.ok(site.derived.unitsPerFloor > 4);
  const bar = site.massing.bars[0];
  for (const core of site.massing.cores) {
    const { along, across } = coreAlongAcross(core, bar);
    assert.ok(Math.abs(along - CORE_WIDTH_ALONG_BAR) < 1e-6, `core ${along} m along the bar`);
    // No lift, so the stair run plus its lobby is all the depth the core needs.
    assert.ok(across >= coreAcrossFor(spec.massing.groundFloorToFloor!, false) - 1e-6, `core only ${across} m across`);
    assert.ok(rectContainsRect(bar.rect, core.rect, 1e-3), 'core escapes its bar');
  }
  // Every landing gets the same frontage on both sides.
  const along = site.massing.cores.map(c => (bar.axis === 'x' ? c.rect.x - bar.rect.x : c.rect.y - bar.rect.y)).sort((a, b) => a - b);
  const slice = bar.length / n;
  for (let i = 0; i < along.length; i++) {
    assert.ok(Math.abs(along[i] + CORE_WIDTH_ALONG_BAR / 2 - (i + 0.5) * slice) < 1e-6, 'cores not evenly distributed');
  }
  // Southern hemisphere: the sunny side is scored, and the block keeps its street line.
  assert.ok(site.patterns.some(a => a.patternId === 'SIT-04' && a.params && a.params.hemisphere === 'southern'));
});

test('uk-mansion: exactly two cores, each big enough for a dog-leg stair, a lift and the shaft bay', () => {
  const { site, spec } = build(preset('uk-mansion'));
  const bar = site.massing.bars[0];
  assert.equal(site.massing.bars.length, 1);
  assert.ok(Math.abs(bar.length - 46) < 1e-6, `bar is ${bar.length} m long, not the 46 m the rule was sized for`);
  assert.equal(site.massing.cores.length, 2, `${site.massing.cores.length} cores on a 46 m mansion bar`);
  assert.equal(site.massing.corridors.length, 0, 'a mansion block has landings, not corridors');
  for (const core of site.massing.cores) {
    const { along, across } = coreAlongAcross(core, bar);
    assert.ok(along >= 5.0 - 1e-6, `core only ${along} m along the bar (needs 2.6 m stair bay + 2.4 m shaft bay)`);
    assert.ok(across >= 7.8 - 1e-6, `core only ${across} m across (needs a 4.3 m stair run + 2.3 m lift bank + 1.2 m lobby)`);
    assert.ok(rectContainsRect(bar.rect, core.rect, 1e-3), 'core escapes its bar');
    assert.equal(core.type, 'stair-elevator');
    assert.ok(core.hasElevator && core.elevatorCount >= 1);
  }
  // The stair has to climb the tallest floor-to-floor in the building.
  const f2f = Math.max(spec.massing.floorToFloor!, spec.massing.groundFloorToFloor!);
  assert.ok(Math.abs(stairRunFor(f2f) - 4.3) < 1e-9, `stair run ${stairRunFor(f2f)} m for a ${f2f} m floor-to-floor`);
  // Each landing keeps equal frontage on both sides, and enough of it for a flat from the mix.
  const perSide = (bar.length / 2 - 5.0) / 2;
  assert.ok(perSide >= 8.5, `only ${perSide.toFixed(1)} m of frontage per landing side`);
  const app = site.patterns.find(a => a.patternId === 'SIT-08');
  assert.ok(app && app.params && app.params.shaftBayAlong === CORE_SHAFT_BAY, 'SIT-08 does not record the shaft bay');
  assert.ok(site.patterns.some(a => a.patternId === 'XD-04'), 'XD-04 never applied');
});

test('ca-laneway: ADU at the rear behind a notional main house', () => {
  const { site } = build(PRESETS.find(p => p.id === 'ca-laneway')!);
  const B = boundaryRect(site);
  const bar = site.massing.bars[0];
  assert.ok(bar.rect.y > B.h * 0.3, 'ADU is not at the rear of the lot');
  const proxy = site.elements.find(e => e.objectType === 'ExistingHouse');
  assert.ok(proxy, 'no notional main house');
  assert.equal(proxy!.ifcType, 'IfcBuildingElementProxy');
  assert.equal(proxy!.geometry.kind, 'prism');
  if (proxy!.geometry.kind === 'prism') assert.ok(proxy!.geometry.height > 5);
  assert.ok(site.patterns.some(a => a.patternId === 'SIT-05'), 'SIT-05 not applied');
});

test('us-senior: L plan with a corridor and a core per wing', () => {
  const { site } = build(PRESETS.find(p => p.id === 'us-senior')!);
  assert.equal(site.massing.shape, 'L');
  assert.equal(site.massing.bars.length, 2);
  assert.equal(site.massing.corridors.length, 2);
  assert.equal(site.massing.bars.filter(b => b.axis === 'x').length, 1);
  assert.equal(site.massing.bars.filter(b => b.axis === 'y').length, 1);
  for (const bar of site.massing.bars) {
    assert.ok(site.massing.cores.some(c => c.barId === bar.id), `${bar.id} has no core`);
  }
  assert.equal(site.parking!.type, 'surface');
  assert.ok(site.parking!.aisles.length >= 1, 'surface lot without an aisle');
});

test('massing.coreCount overrides the stair-core module, and SIT-08 reports when it is short', () => {
  for (const [coreCount, shape] of [[1, 'bar'], [3, 'bar'], [4, 'bar'], [2, 'U']] as const) {
    const { site, warnings } = buildSpec({
      typology: 'mansion-block', seed: 31, region: 'UK',
      site: { width: 52, depth: 36, streetFacing: 'S', context: 'urban' },
      massing: { storeys: 5, footprintShape: shape, roof: 'flat', coreCount },
    });
    const bars = site.massing.bars;
    const expected = Math.max(coreCount, bars.length);
    assert.equal(site.massing.cores.length, expected, `coreCount ${coreCount} on a ${shape}: got ${site.massing.cores.length}`);
    for (const bar of bars) {
      assert.ok(site.massing.cores.some(c => c.barId === bar.id), `bar ${bar.id} left without a core`);
    }
    const byId = new Map(bars.map(b => [b.id, b]));
    for (const core of site.massing.cores) {
      assert.ok(rectContainsRect(byId.get(core.barId)!.rect, core.rect, 1e-3), 'core escapes its bar');
    }
    assert.deepEqual(warnings.filter(w => HARD_WARNING.test(w)), [], `coreCount ${coreCount} hard warnings`);
    const app = site.patterns.find(a => a.patternId === 'SIT-08');
    assert.equal(app!.params!.source, 'spec.massing.coreCount');
    // One stair for a 5-storey block is not two ways out, and has to be reported.
    if (coreCount === 1 && bars.length === 1) {
      assert.ok(warnings.some(w => /two ways out/.test(w)), 'single core on a 5-storey block not reported');
    }
  }
});

test('ie-courtyard / us-senior / nz-coliving: every core sits inside its own bar', () => {
  for (const id of ['ie-courtyard', 'us-senior', 'nz-coliving']) {
    const { site, spec } = build(preset(id));
    const byId = new Map(site.massing.bars.map(b => [b.id, b]));
    const needAcross = coreAcrossFor(Math.max(spec.massing.floorToFloor!, spec.massing.groundFloorToFloor!), true);
    assert.ok(site.massing.cores.length >= 1, `${id}: no cores`);
    for (const core of site.massing.cores) {
      const bar = byId.get(core.barId);
      assert.ok(bar, `${id}: core ${core.id} has no bar`);
      assert.ok(rectContainsRect(bar!.rect, core.rect, 1e-3), `${id}: core ${core.id} escapes bar ${core.barId}`);
      const { along, across } = coreAlongAcross(core, bar!);
      assert.ok(Math.abs(along - CORE_WIDTH_ALONG_BAR) < 1e-6, `${id}: core ${along} m along the bar`);
      assert.ok(across >= needAcross - 1e-6, `${id}: core only ${across} m across, needs ${needAcross} m`);
      // Never on top of the spine: the corridor has to run past the core.
      const spine = site.massing.corridors.find(c => c.barId === core.barId);
      if (spine) {
        const lo = bar!.axis === 'x' ? core.rect.y : core.rect.x;
        const hi = lo + (bar!.axis === 'x' ? core.rect.h : core.rect.w);
        const c = bar!.axis === 'x' ? spine.centerline.a[1] : spine.centerline.a[0];
        assert.ok(hi <= c - spine.width / 2 + 1e-6 || lo >= c + spine.width / 2 - 1e-6,
          `${id}: core ${core.id} overlaps the corridor spine`);
      }
    }
  }
});

test('deck access: the gallery spine hugs the long face away from the street', () => {
  const { site } = buildSpec({
    typology: 'deck-access', seed: 4, region: 'UK',
    site: { width: 50, depth: 34, streetFacing: 'S', context: 'urban' },
    massing: { storeys: 5, footprintShape: 'bar', roof: 'flat' },
  });
  assert.equal(site.massing.corridors.length, 1);
  const spine = site.massing.corridors[0];
  const bar = site.massing.bars.find(b => b.id === spine.barId)!;
  assert.equal(spine.loaded === 'left' || spine.loaded === 'right', true, 'a gallery is single-loaded');
  assert.ok(spineToFace(spine, bar) <= 1.0 + 1e-6,
    `gallery centreline is ${spineToFace(spine, bar).toFixed(2)} m from the nearest long face`);
  // ... and it is the face AWAY from the street (the street is the y = 0 edge).
  const across = (spine.centerline.a[1] + spine.centerline.b[1]) / 2 - bar.rect.y;
  assert.ok(across > bar.depth / 2, 'the deck should be on the rear face, not the street face');
  // The core still fits beside the deck without standing in it.
  for (const core of site.massing.cores) {
    assert.ok(rectContainsRect(bar.rect, core.rect, 1e-3), 'core escapes its bar');
    assert.ok(core.rect.y + core.rect.h <= bar.rect.y + across - spine.width / 2 + 1e-6, 'core stands in the deck');
  }
  // An L plan puts the deck on the courtyard side of each wing, still within 1 m of a face.
  const { site: lPlan } = buildSpec({
    typology: 'deck-access', seed: 6, region: 'UK',
    site: { width: 60, depth: 60, streetFacing: 'S', context: 'urban' },
    massing: { storeys: 5, footprintShape: 'L', roof: 'flat' },
  });
  for (const s of lPlan.massing.corridors) {
    const b = lPlan.massing.bars.find(x => x.id === s.barId)!;
    assert.ok(spineToFace(s, b) <= 1.0 + 1e-6, `wing spine ${spineToFace(s, b).toFixed(2)} m from a face`);
  }
});

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

test('22-storey podium tower generates in well under 300 ms', () => {
  const tower = preset('ca-point-tower');
  build(tower);                        // warm the code paths
  const runs = [build(tower), build(tower), build(tower)].map(b => b.ms);
  const best = Math.min(...runs);
  assert.ok(best < 300, `site generation took ${best.toFixed(1)} ms`);
});

test('every typology and footprint shape produces a sane model', () => {
  const shapes = ['bar', 'L', 'U', 'O', 'T', 'point'] as const;
  let n = 0;
  for (const tid of TYPOLOGY_IDS) {
    const typology = getTypology(tid);
    for (const shape of shapes) {
      for (const storeys of [typology.storeys.min, typology.storeys.max]) {
        const spec = normalizeSpec({
          typology: tid, seed: 300 + n, region: 'US',
          massing: { storeys, footprintShape: shape, roof: 'flat' },
          options: { detail: n % 2 === 0 ? 'low' : 'high' },
        });
        const warnings: string[] = [];
        const site = generateSite(spec, typology, createRng(spec.seed).fork('site'), warnings);
        n++;
        assert.ok(site.elements.length > 0, `${tid}/${shape}: no elements`);
        assert.ok(site.massing.bars.length > 0, `${tid}/${shape}: no bars`);
        assert.ok(site.massing.storeys.length >= 3, `${tid}/${shape}: storeys`);
        assert.deepEqual(warnings.filter(w => HARD_WARNING.test(w)), [], `${tid}/${shape} hard warnings`);
        for (const key of Object.keys(site.derived)) {
          assert.ok(Number.isFinite(site.derived[key]), `${tid}/${shape}: derived.${key}`);
        }
        assert.ok(site.derived.coverage > 0 && site.derived.coverage <= 1, `${tid}/${shape}: coverage ${site.derived.coverage}`);
        assert.ok(site.derived.far > 0, `${tid}/${shape}: far`);
      }
    }
  }
  assert.ok(n >= 32, 'combination sweep did not run');
});

// ---------------------------------------------------------------------------
// v2 resolutions: parking solver, storey band, corridor graph
//
// These are the "warnings → zero" invariants for site (plan rows 1, 2-3 and 25-27): a request the
// generator cannot honour must be RESOLVED and recorded as an Issue, never merely reported.
// ---------------------------------------------------------------------------

/** Minimal Ledger so the tests can read the structured issues the pipeline will thread in. */
function makeLedger(mirror: string[] = []): Ledger {
  const issues: Issue[] = [];
  const keys = new Map<string, Issue>();
  const add = (d: Deviation): Issue => {
    const issue: Issue = { id: `ISS-${String(issues.length + 1).padStart(4, '0')}`, ...d };
    issues.push(issue);
    if (issue.severity !== 'info') mirror.push(issue.message);
    return issue;
  };
  return {
    add,
    addOnce: (key: string, d: Deviation): Issue | null => {
      const seen = keys.get(key);
      if (seen) { seen.count = (seen.count ?? 1) + 1; return null; }
      const issue = add(d);
      keys.set(key, issue);
      return issue;
    },
    all: () => issues,
    bySeverity: (s) => issues.filter(i => i.severity === s),
    byRule: (ruleId) => issues.filter(i => i.ruleId === ruleId),
    counts: () => ({
      info: issues.filter(i => i.severity === 'info').length,
      deviation: issues.filter(i => i.severity === 'deviation').length,
      violation: issues.filter(i => i.severity === 'violation').length,
      error: issues.filter(i => i.severity === 'error').length,
    }),
    warnings: (o) => issues.filter(i => (o?.includeInfo ?? false) || i.severity !== 'info').map(i => i.message),
  };
}

interface Recorded extends Built { ledger: Ledger }

function record(partial: PartialSpec): Recorded {
  const spec = normalizeSpec(partial);
  const typology = getTypology(spec.typology);
  const warnings: string[] = [];
  const ledger = makeLedger(warnings);
  const t0 = performance.now();
  const site = generateSite(spec, typology, createRng(spec.seed).fork('site'), warnings, undefined, ledger);
  return { spec, typology, site, warnings, ms: performance.now() - t0, ledger };
}

const MAX_LEG = 45;

test('parking: every preset builds what it owes, or records a relax-parking-ratio deviation', () => {
  for (const p of PRESETS) {
    const { site, ledger, spec } = record(p.spec);
    const required = site.derived.parkingRequired;
    const achieved = site.derived.parkingSpaces;
    const relaxed = ledger.all().filter(i => i.resolution?.id === 'relax-parking-ratio');
    if (achieved >= required) {
      assert.deepEqual(relaxed, [], `${p.id}: ratio relaxed although ${achieved} >= ${required}`);
    } else {
      assert.equal(relaxed.length, 1, `${p.id}: ${achieved} of ${required} stalls with no recorded deviation`);
      assert.equal(relaxed[0].severity, 'deviation');
      assert.ok(Number(relaxed[0].limit) === required, `${p.id}: deviation limit ${relaxed[0].limit} != ${required}`);
    }
    // every added level is an `info` resolution, and the spec's storey stack carries it
    for (const i of ledger.all().filter(x => x.resolution?.id === 'add-basement-level')) {
      assert.equal(i.severity, 'info', `${p.id}: an added basement must not be a warning`);
      assert.ok(spec.floors.some(f => f.index < 0 && f.use === 'parking'), `${p.id}: basement missing from the floors`);
      assert.ok(site.massing.storeys.some(s => s.id === i.storey), `${p.id}: storey ${i.storey} not in the stack`);
    }
    // stalls only ever land on a storey that exists and is a parking (or site) storey
    for (const s of site.parking!.spaces) {
      assert.ok(site.massing.storeys.some(st => st.id === s.storey), `${p.id}: stall on unknown storey ${s.storey}`);
    }
  }
});

test('parking: the solver sizes the basements, and a shortfall is impossible to reach silently', () => {
  // 0.7 cars/unit on a 121-unit tower needs 85 stalls; one basement plate holds 57.
  const { site, ledger, spec } = record(preset('ca-point-tower').spec);
  assert.equal(spec.massing.basementStoreys, 2);
  assert.equal(site.derived.parkingSpaces, site.derived.parkingRequired);
  assert.equal(site.derived.parkingRatioApplied, site.derived.parkingRatioRequested);
  assert.equal(site.derived.parkingLevels, 2);
  assert.deepEqual(ledger.all().filter(i => i.ruleId === 'SIT-07.parkingRatio'), []);
  assert.equal(ledger.byRule('SIT-07.parkingLevels').length, 1);
  assert.deepEqual(site.massing.storeys.filter(s => s.index < 0 && s.index > -100).map(s => s.id), ['B2', 'B1']);
});

test('storeys: every preset is inside its typology band, and an override is recorded as a deviation', () => {
  for (const p of PRESETS) {
    const { spec, typology, ledger } = record(p.spec);
    assert.ok(spec.massing.storeys >= typology.storeys.min && spec.massing.storeys <= typology.storeys.max,
      `${p.id}: ${spec.massing.storeys} storeys outside ${typology.storeys.min}–${typology.storeys.max}`);
    assert.deepEqual(ledger.byRule('TYP-01.storeyBand'), [], `${p.id}: in-band spec should record nothing`);
  }

  // a request above the band is clamped …
  const clamped = normalizeSpec({ typology: 'courtyard-block', seed: 3, massing: { storeys: 15, roof: 'flat' } });
  assert.equal(clamped.massing.storeys, getTypology('courtyard-block').storeys.max);
  assert.equal(clamped.rules?.profiles?.includes('high-rise') ?? false, false);

  // … unless the override is asked for, which switches the rule profile and records a deviation
  const over = record({ typology: 'courtyard-block', seed: 3, massing: { storeys: 15, roof: 'flat', allowStoreyOverride: true } });
  assert.equal(over.spec.massing.storeys, 15);
  assert.deepEqual(over.spec.rules?.profiles, ['high-rise']);
  const band = over.ledger.byRule('TYP-01.storeyBand');
  assert.equal(band.length, 1);
  assert.equal(band[0].severity, 'deviation');
  assert.equal(band[0].resolution?.id, 'switch-highrise-ruleset');
  assert.equal(band[0].observed, 15);
  assert.equal(band[0].limit, getTypology('courtyard-block').storeys.max);
  assert.equal(over.site.derived.storeysAboveGrade, 15);

  // below the band, honoured with the override, is a deviation without the high-rise profile
  const under = record({ typology: 'mansion-block', seed: 3, massing: { storeys: 2, roof: 'flat', allowStoreyOverride: true } });
  assert.equal(under.spec.massing.storeys, 2);
  assert.equal(under.ledger.byRule('TYP-01.storeyBand')[0].resolution?.id, 'none');
});

test('corridors: no leg over 45 m, no dead end over the limit, break slots disjoint from the cores', () => {
  for (const p of PRESETS) {
    const { site, typology } = record(p.spec);
    const graph = site.massing.corridorGraph;
    if (!graph || graph.legs.length === 0) continue;
    const deadEndLimit = typology.sprinklered ? 15 : 6;
    for (const leg of graph.legs) {
      assert.ok(leg.length <= MAX_LEG + 1e-6, `${p.id}: leg ${leg.id} is ${leg.length.toFixed(1)} m`);
      assert.ok(leg.length > 0.5, `${p.id}: leg ${leg.id} is a stub of ${leg.length.toFixed(2)} m`);
    }
    for (const d of graph.deadEnds) {
      assert.ok(d.length <= deadEndLimit + 1e-6, `${p.id}: ${d.length} m dead end at ${d.legId} (limit ${deadEndLimit})`);
      assert.ok(graph.legs.some(l => l.id === d.legId), `${p.id}: dead end on unknown leg ${d.legId}`);
    }
    // a spine's legs cover it exactly once, in order, and stay inside the union of the bars
    const byId = new Map(site.massing.bars.map(b => [b.id, b]));
    for (const leg of graph.legs) {
      const bar = byId.get(leg.barId);
      assert.ok(bar, `${p.id}: leg ${leg.id} references unknown bar ${leg.barId}`);
      for (const pt of [leg.centerline[0].a, leg.centerline[0].b]) {
        assert.ok(site.massing.bars.some(b => pt[0] >= b.rect.x - 0.01 && pt[0] <= b.rect.x + b.rect.w + 0.01
          && pt[1] >= b.rect.y - 0.01 && pt[1] <= b.rect.y + b.rect.h + 0.01),
          `${p.id}: leg ${leg.id} end (${pt[0].toFixed(1)}, ${pt[1].toFixed(1)}) is outside every bar`);
      }
    }
    // break slots: inside their bar, pairwise disjoint per bar, and clear of every core
    for (const barId of new Set(graph.breakSlots.map(s => s.barId))) {
      const bar = byId.get(barId)!;
      const slots = graph.breakSlots.filter(s => s.barId === barId).sort((a, b) => a.station - b.station);
      for (let i = 1; i < slots.length; i++) {
        assert.ok(slots[i].station - slots[i].length / 2 >= slots[i - 1].station + slots[i - 1].length / 2 - 1e-6,
          `${p.id}: break slots ${slots[i - 1].id} and ${slots[i].id} overlap`);
      }
      for (const s of slots) {
        for (const core of site.massing.cores.filter(c => c.barId === barId)) {
          const a = bar.axis === 'x' ? core.rect.x - bar.rect.x : core.rect.y - bar.rect.y;
          const w = bar.axis === 'x' ? core.rect.w : core.rect.h;
          const clear = s.station + s.length / 2 <= a + 1e-6 || s.station - s.length / 2 >= a + w - 1e-6;
          assert.ok(clear, `${p.id}: break slot ${s.id} at ${s.station} overlaps core ${core.id} (${a}–${a + w})`);
        }
      }
    }
    assert.ok(graph.longestRunM >= Math.max(...graph.legs.map(l => l.length)) - 1e-6);
  }
});

test('corridors: the ie-courtyard O-plan is one connected corridor with four knuckles', () => {
  const { site } = record(preset('ie-courtyard').spec);
  const graph = site.massing.corridorGraph!;
  assert.equal(graph.spines.length, 4);
  assert.equal(graph.knuckles.length, 4, `knuckles ${graph.knuckles.length}`);
  const { adj, count } = legGraph(graph.legs, graph.spines[0].width);
  const seen = new Set<number>([0]);
  const queue = [0];
  while (queue.length > 0) {
    const at = queue.shift()!;
    for (const e of adj.get(at) ?? []) {
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      queue.push(e.to);
    }
  }
  assert.equal(seen.size, count, `the perimeter block is ${count - seen.size + 1} corridors, not one`);
  assert.ok(graph.legs.length >= count, 'the loop is not cyclic');
  assert.ok(graph.longestRunM > 150, `longest run ${graph.longestRunM} m should cross the whole block`);
  // every knuckle rect sits inside the plate
  for (const k of graph.knuckles) {
    assert.ok(site.massing.bars.some(b => k.rect.x >= b.rect.x - 0.01 && k.rect.y >= b.rect.y - 0.01
      && k.rect.x + k.rect.w <= b.rect.x + b.rect.w + 0.01 && k.rect.y + k.rect.h <= b.rect.y + b.rect.h + 0.01),
      `knuckle ${k.id} is not inside a bar`);
  }
});

test('corridors: cores prefer the break slots, and the spine still runs the full bar', () => {
  const { site } = record(preset('us-5-over-1').spec);
  const graph = site.massing.corridorGraph!;
  const bar = site.massing.bars[0];
  assert.equal(graph.legs.length, 2, 'a 72 m bar needs two legs');
  const spine = site.massing.corridors[0];
  assert.ok(Math.abs(spine.centerline.b[0] - spine.centerline.a[0] - bar.length) < 1e-6,
    'v1 consumers still need the full-length centreline');
  assert.deepEqual(spine.legs?.length, 2);
  // the mid-bar break is left for a lounge; the cores sit clear of it
  assert.equal(graph.breakSlots.length, 1);
  assert.equal(graph.breakSlots[0].want, 'core');
  assert.ok(site.derived.maxTravelDistance <= site.derived.travelLimit);
  assert.equal(site.derived.corridorLegCount, 2);
  assert.ok(site.derived.corridorLongestRun > 0);
});

test('corridors: every typology and shape keeps the leg and dead-end limits', () => {
  const shapes = ['bar', 'L', 'U', 'O', 'T', 'point'] as const;
  let checked = 0;
  for (const tid of TYPOLOGY_IDS) {
    const typology = getTypology(tid);
    for (const shape of shapes) {
      const { site } = record({
        typology: tid, seed: 700 + checked, region: 'US',
        massing: { storeys: typology.storeys.default, footprintShape: shape, roof: 'flat' },
      });
      const graph = site.massing.corridorGraph;
      checked++;
      if (!graph || graph.legs.length === 0) continue;
      const limit = typology.sprinklered ? 15 : 6;
      for (const leg of graph.legs) {
        assert.ok(leg.length <= MAX_LEG + 1e-6, `${tid}/${shape}: leg ${leg.length.toFixed(1)} m`);
      }
      for (const d of graph.deadEnds) {
        assert.ok(d.length <= limit + 1e-6, `${tid}/${shape}: dead end ${d.length} m over ${limit} m`);
      }
      assert.equal(graph.spines.length, site.massing.corridors.length);
    }
  }
  assert.ok(checked >= 32, 'sweep did not run');
});

test('the resolutions are deterministic: same spec → same issues and same graph', () => {
  for (const p of PRESETS) {
    const a = record(p.spec);
    const b = record(p.spec);
    assert.equal(JSON.stringify(a.ledger.all()), JSON.stringify(b.ledger.all()), `${p.id} issues not deterministic`);
    assert.equal(JSON.stringify(a.site.massing.corridorGraph), JSON.stringify(b.site.massing.corridorGraph),
      `${p.id} corridor graph not deterministic`);
    assert.deepEqual(a.warnings, b.warnings);
  }
});

test('site generation stays inside its budget on the biggest plan', () => {
  const p = preset('ie-courtyard');
  record(p.spec);
  const best = Math.min(...[record(p.spec), record(p.spec), record(p.spec)].map(r => r.ms));
  assert.ok(best < 200, `ie-courtyard site generation took ${best.toFixed(1)} ms`);
});
