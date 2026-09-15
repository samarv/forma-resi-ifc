/**
 * Step 3 — branches (PLB-02 Short Trap Arms, PLB-03 branch vents).
 *
 * Every fixture gets an L-shaped waste branch (fixture → perpendicular into the wet wall → along
 * the wall centreline → stack) at z = -0.12, supply branches in the wall at z = 0.45 (DCW) and
 * 0.55 (DHW) that rise to the fixture's supply height, and a branch vent at z = 1.5 per trap group.
 */
import type { PipeSystemType, Vec2, Vec3 } from '../../core/types.ts';
import { add, projectOnSegment, round, scale, segDir, segPointAt } from '../../core/geometry.ts';
import { maxTrapArm } from './tables.ts';
import {
  emitRun, warn, bump, BRANCH_VENT_Z, DCW_BRANCH_Z, DHW_BRANCH_Z, WASTE_Z,
  type PlumbState, type StackInfo,
} from './state.ts';
import type { PlacedFixture } from './fixtures.ts';
import { stackXY } from './stacks.ts';

/** Point in the wall's frame: `along` metres from wall.a, `off` metres left of the wall direction */
function framePoint(f: PlacedFixture, along: number, off: number): Vec2 {
  const d = segDir(f.wall);
  const n: Vec2 = [-d[1], d[0]];
  return add(segPointAt(f.wall, along), scale(n, off));
}

interface StationOf {
  along: number;
  off: number;
  xy: Vec2;
}

function stationOf(f: PlacedFixture, si: StackInfo, system: PipeSystemType): StationOf {
  const xy = stackXY(si, system);
  const pr = projectOnSegment(f.wall, xy);
  return { along: pr.along, off: pr.offset, xy };
}

export function buildBranches(st: PlumbState, placed: PlacedFixture[]): void {
  const simple = st.detail === 'low';
  const worstByStack = new Map<number, number>();

  for (const f of placed) {
    if (f.stackIdx < 0) continue;
    const si = st.stacks[f.stackIdx];
    const spec = f.spec;

    // --- waste / trap arm --------------------------------------------------
    if (spec.wasteD > 0) {
      const s = stationOf(f, si, 'waste');
      const armLen = Math.abs(f.offset - s.off) + Math.abs(f.along - s.along);
      const limit = maxTrapArm(spec.wasteD);
      const entry = framePoint(f, f.along, s.off);
      // A run past the unvented limit becomes an individually vented branch drain, one size up
      const vented = !!f.vented || armLen > limit + 1e-3;
      const diameter = vented ? Math.max(spec.wasteD, 0.075) : spec.wasteD;
      const path: Vec3[] = simple
        ? [[f.center[0], f.center[1], WASTE_Z], [s.xy[0], s.xy[1], WASTE_Z]]
        : [
          [f.center[0], f.center[1], 0],
          [f.center[0], f.center[1], WASTE_Z],
          [entry[0], entry[1], WASTE_Z],
          [s.xy[0], s.xy[1], WASTE_Z],
        ];
      emitRun(st, {
        storey: f.storey, system: 'waste', diameter, path,
        servesFixtureIds: [f.fixture.id], unitId: f.unitId, roomId: f.roomId,
        stackId: si.stack.id,
        name: vented
          ? `Vented branch drain Ø${Math.round(diameter * 1000)}`
          : `Waste branch Ø${Math.round(diameter * 1000)}`,
        patterns: ['PLB-02', ...(vented ? ['PLB-03'] : [])],
        psetExtra: [
          { name: 'DFU', value: f.fixture.dfu },
          { name: 'TrapArmLength', value: round(armLen, 3) },
          { name: 'TrapArmLimit', value: limit },
          { name: 'Vented', value: vented },
          { name: 'Slope', value: 0.02 },
        ],
      });
      worstByStack.set(f.stackIdx, Math.max(worstByStack.get(f.stackIdx) ?? 0, armLen));
      if (armLen > limit + 1e-3) {
        warn(st, `arm:${f.fixture.type}`,
          `trap arm ${round(armLen, 2)} m on Ø${Math.round(spec.wasteD * 1000)} exceeds the ${limit} m unvented limit (IPC Table 1002.2) at ${f.roomId ?? f.storey}; drained as an individually vented Ø${Math.round(diameter * 1000)} branch (IPC 912)`);
      }
      bump(st, 'wasteBranches');
      if (vented) bump(st, 'ventedBranchDrains');
    }

    // --- supply ------------------------------------------------------------
    for (const system of ['dcw', 'dhw'] as PipeSystemType[]) {
      if (!spec.connections.includes(system)) continue;
      if (spec.supplyD <= 0) continue;
      const z = system === 'dcw' ? DCW_BRANCH_Z : DHW_BRANCH_Z;
      const s = stationOf(f, si, system);
      const mid = framePoint(f, f.along, s.off);
      const path: Vec3[] = simple
        ? [[s.xy[0], s.xy[1], z], [f.center[0], f.center[1], spec.supplyZ]]
        : [
          [s.xy[0], s.xy[1], z],
          [mid[0], mid[1], z],
          [mid[0], mid[1], spec.supplyZ],
          [f.center[0], f.center[1], spec.supplyZ],
        ];
      emitRun(st, {
        storey: f.storey, system, diameter: spec.supplyD, path,
        servesFixtureIds: [f.fixture.id], unitId: f.unitId, roomId: f.roomId,
        stackId: si.stack.id,
        name: `${system === 'dcw' ? 'Cold' : 'Hot'} water branch Ø${Math.round(spec.supplyD * 1000)}`,
        patterns: ['PLB-02', 'PLB-08'],
        psetExtra: [{ name: 'WSFU', value: f.fixture.wsfu }, { name: 'OutletHeight', value: spec.supplyZ }],
      });
      bump(st, 'supplyBranches');
    }
  }

  // --- branch vents, one per trap group (room × stack) ----------------------
  const groups = new Map<string, PlacedFixture[]>();
  for (const f of placed) {
    if (f.stackIdx < 0 || f.spec.wasteD <= 0) continue;
    const key = `${f.storey}|${f.roomId ?? 'x'}|${f.stackIdx}`;
    const g = groups.get(key);
    if (g) g.push(f); else groups.set(key, [f]);
  }
  for (const key of [...groups.keys()].sort()) {
    const g = groups.get(key)!;
    const si = st.stacks[g[0].stackIdx];
    const s = stationOf(g[0], si, 'vent');
    // vent the fixture furthest from the stack (it is the one at risk of siphoning)
    const far = g.reduce((a, b) =>
      Math.abs(b.along - s.along) + Math.abs(b.offset - s.off) > Math.abs(a.along - s.along) + Math.abs(a.offset - s.off) ? b : a);
    const mid = framePoint(far, far.along, s.off);
    const path: Vec3[] = [
      [far.center[0], far.center[1], BRANCH_VENT_Z],
      [mid[0], mid[1], BRANCH_VENT_Z],
      [s.xy[0], s.xy[1], BRANCH_VENT_Z],
    ];
    emitRun(st, {
      storey: far.storey, system: 'vent', diameter: 0.05, path,
      servesFixtureIds: g.map(f => f.fixture.id), unitId: far.unitId, roomId: far.roomId,
      stackId: si.stack.id, name: 'Branch vent Ø50', patterns: ['PLB-03'],
      psetExtra: [{ name: 'TrapsVented', value: g.length }],
    });
    bump(st, 'ventBranches');
  }

  for (const [idx, worst] of [...worstByStack.entries()].sort((a, b) => a[0] - b[0])) {
    const si = st.stacks[idx];
    st.apps.push({
      patternId: 'PLB-02',
      storey: si.stack.fromStorey,
      params: {
        stackId: si.stack.id,
        fixtures: si.fixtureIds.length,
        worstTrapArm: round(worst, 2),
        limitDn50: 1.5,
        limitDn100: 3.0,
        wasteInvertZ: WASTE_Z,
      },
    });
  }
}
