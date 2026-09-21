/**
 * Cross-discipline port tests.
 *
 * Ports are the seam that replaces rediscovery: the unit layout publishes where its stacks, extracts and panel go,
 * and plumbing / mechanical / electrical consume those points instead of re-deriving them from walls and furniture
 * (v1 plumbing hunted for a wet wall, synthesised missing fixtures, then repaired the result with a second stack).
 * Two properties make them usable:
 *
 *   1. identical units stack — the port's `atFrac` is a fraction of the unit's frontage, so the same module on
 *      another storey publishes the same fraction and the same world XY;
 *   2. every wet fixture is within a trap arm of its station, so no branch needs its own vent
 *      (IPC 2021 Table 1002.2: 1.83 m for a 50 mm branch).
 *
 *   node --test src/ports.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { GenContext, UnitInstance } from './core/types.ts';
import { PRESETS, normalizeSpec } from './core/spec.ts';
import { getTypology } from './core/typologies.ts';
import { createRng } from './core/rng.ts';
import { maxTrapArm } from './disciplines/plumbing/tables.ts';
import { generateArchitecture, resolveArchitectureDeps } from './disciplines/architecture/index.ts';
import { makeFixture, type FixtureKind } from './disciplines/architecture/test-fixtures.ts';

await resolveArchitectureDeps();

/**
 * Trap-arm limit for the 50 mm branch a dwelling fixture group drains into. `maxTrapArm(0.05)` is the same number
 * once the kernel agent corrects `plumbing/tables.ts` to IPC 2021 Table 1002.2 (2 in → 6 ft → 1.83 m); until then
 * the table returns the 1½ in value, so the test takes the larger of the two and holds either way.
 */
const TRAP_ARM = Math.max(maxTrapArm(0.05), 1.83);

const SYSTEMS = new Set(['waste', 'vent', 'dcw', 'dhw']);

function assertPorts(label: string, units: readonly UnitInstance[]): number {
  let ports = 0;
  for (const u of units) {
    assert.ok(u.stackPorts && u.stackPorts.length > 0, `${label}: ${u.id} has no stack port`);
    assert.ok(u.panelPort, `${label}: ${u.id} has no panel port`);
    const ids = new Set<string>();
    for (const s of u.stackPorts!) {
      ports++;
      assert.ok(!ids.has(s.id), `${label}: ${u.id} repeats port id ${s.id}`);
      ids.add(s.id);
      assert.ok(s.wallId.length > 0, `${label}: ${s.id} has no host wall`);
      assert.ok(s.serves.length > 0, `${label}: ${s.id} serves nothing`);
      assert.deepEqual([...s.serves].sort(), s.serves, `${label}: ${s.id} serves an unsorted room list`);
      assert.ok(s.atFrac >= 0 && s.atFrac <= 1, `${label}: ${s.id} atFrac ${s.atFrac}`);
      assert.ok(s.systems.length > 0 && s.systems.every(x => SYSTEMS.has(x)), `${label}: ${s.id} systems ${s.systems}`);
      assert.ok(Number.isFinite(s.xy[0]) && Number.isFinite(s.xy[1]), `${label}: ${s.id} xy ${s.xy}`);
      assert.ok(s.maxArm <= TRAP_ARM + 1e-6,
        `${label}: ${u.id} ${s.id} serving ${s.serves.join('+')} has a ${s.maxArm.toFixed(2)} m trap arm (limit ${TRAP_ARM} m)`);
    }
    for (const e of u.exhaustPorts ?? []) {
      assert.ok(e.flowLs > 0, `${label}: ${e.id} moves no air`);
      assert.ok(e.atFrac >= 0 && e.atFrac <= 1, `${label}: ${e.id} atFrac ${e.atFrac}`);
      assert.ok(['kitchen', 'bath', 'dryer', 'mvhr'].includes(e.kind), `${label}: ${e.id} kind ${e.kind}`);
    }
    // the panel goes in a room of the dwelling, at a reachable height (ADA 308: 0.4–1.2 m to the handle;
    // the board's centre sits at 1.575 m with its breakers inside reach)
    assert.ok(u.roomIds.includes(u.panelPort!.roomId), `${label}: ${u.id} panel port is not in one of its rooms`);
    assert.ok(u.panelPort!.height > 1 && u.panelPort!.height < 2, `${label}: panel at ${u.panelPort!.height} m`);
  }
  return ports;
}

/** Units that occupy the same footprint on different storeys are the same module stacked */
function stacks(units: readonly UnitInstance[]): UnitInstance[][] {
  const groups = new Map<string, UnitInstance[]>();
  for (const u of units) {
    const k = `${u.templateId}|${u.rect.x.toFixed(3)},${u.rect.y.toFixed(3)},${u.rect.w.toFixed(3)},${u.rect.h.toFixed(3)}`;
    const g = groups.get(k) ?? [];
    g.push(u);
    groups.set(k, g);
  }
  return [...groups.values()].filter(g => g.length > 1);
}

function assertAligned(label: string, units: readonly UnitInstance[]): number {
  let compared = 0;
  for (const group of stacks(units)) {
    const [first, ...rest] = group;
    for (const other of rest) {
      assert.equal(other.stackPorts!.length, first.stackPorts!.length,
        `${label}: ${other.id} publishes ${other.stackPorts!.length} stack ports, ${first.id} ${first.stackPorts!.length}`);
      for (let i = 0; i < first.stackPorts!.length; i++) {
        const a = first.stackPorts![i];
        const b = other.stackPorts![i];
        assert.equal(b.atFrac, a.atFrac, `${label}: ${other.id} ${b.id} atFrac drifts from ${first.id}`);
        assert.ok(Math.abs(b.xy[0] - a.xy[0]) < 1e-4 && Math.abs(b.xy[1] - a.xy[1]) < 1e-4,
          `${label}: ${other.id} ${b.id} at ${b.xy} is not above ${first.id} ${a.id} at ${a.xy}`);
        assert.deepEqual(b.systems, a.systems, `${label}: ${b.id} systems differ up the stack`);
        compared++;
      }
      for (let i = 0; i < (first.exhaustPorts ?? []).length; i++) {
        assert.equal(other.exhaustPorts![i].atFrac, first.exhaustPorts![i].atFrac,
          `${label}: ${other.id} exhaust ${i} drifts from ${first.id}`);
      }
    }
  }
  return compared;
}

const FIXTURE_KINDS: FixtureKind[] = ['bar-double', 'point', 'townhouse', 'walkup', 'gallery'];

test('fixture floors: every dwelling publishes usable ports', () => {
  for (const kind of FIXTURE_KINDS) {
    const fx = makeFixture(kind);
    const arch = generateArchitecture(fx.ctx);
    const ports = assertPorts(kind, arch.units);
    assert.ok(ports >= arch.units.length, `${kind}: ${ports} stack ports for ${arch.units.length} dwellings`);
    assertAligned(kind, arch.units);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// the ten presets (skipped automatically while disciplines/site is unavailable)
// ---------------------------------------------------------------------------------------------------------------

let generateSite: ((...a: never[]) => unknown) | null = null;
try {
  const m = await import('./disciplines/site/index.ts') as { generateSite?: (...a: never[]) => unknown };
  generateSite = m.generateSite ?? null;
} catch {
  generateSite = null;
}

test('all ten presets: stacked dwellings publish identical ports, every fixture inside a trap arm', { skip: !generateSite }, () => {
  let ports = 0;
  let compared = 0;
  for (const p of PRESETS) {
    const spec = normalizeSpec(p.spec);
    const typology = getTypology(spec.typology);
    const rng = createRng(spec.seed);
    const warnings: string[] = [];
    const site = (generateSite as unknown as (
      s: typeof spec, t: typeof typology, r: ReturnType<typeof createRng>, w: string[],
    ) => GenContext['site'])(spec, typology, rng.fork('site'), warnings);
    const ctx: GenContext = {
      spec, typology, rng: rng.fork('architecture'), storeys: site.massing.storeys, site,
      arch: null, struct: null, mech: null, plumb: null, elec: null, warnings,
    };
    const arch = generateArchitecture(ctx);
    ports += assertPorts(p.id, arch.units);
    compared += assertAligned(p.id, arch.units);
  }
  assert.ok(ports > 1000, `only ${ports} stack ports over ten presets`);
  assert.ok(compared > 500, `only ${compared} stacked ports compared`);
});
