/**
 * Core modules: stair configuration × lift count, each carrying the THREE purpose-tagged shaft slots plus the refuse
 * chute and (when there is room) a lift lobby. `coreFootprintAt(id, f2f)` is the only place a stair run is sized:
 * risers(f2f) × tread + landings across the bar, flights + lift bank + lobby along it. The placer asks for the
 * footprint BEFORE it packs, which is what makes "core spacing leaves only N m per landing side" unreachable.
 *
 * `shaftSlots` fractions are measured on the SHAFT BAY beside the core (the 2.4 m along × core-depth across rect),
 * from its low-along, corridor-side corner: `atFrac` along the bay, `wFrac`/`dFrac` of the bay's along/across extent.
 */
import type { ShaftDef } from '../core/types.ts';
import type { CoreModule, Port, StairConfig } from './types.ts';
import { coreModuleId } from './ids.ts';

/** IBC 2021 §1011.5.2 (riser ≤ 7", tread ≥ 11") in the metric form the v1 SIZES table uses */
export const STAIR_RULES = { riserMax: 0.175, treadMin: 0.28, width: 1.1, landing: 1.1 };

export interface CoreFootprint { along: number; across: number }

const LIFT_SLICE = 2.3;
const LOBBY_MIN = 1.8;

/** Flights of a config at one floor-to-floor */
export function flightsFor(stair: StairConfig, f2f: number, riserMax = STAIR_RULES.riserMax): { risers: number; perFlight: number; flights: 1 | 2 } {
  const risers = Math.max(2, Math.ceil(f2f / riserMax));
  if (stair === 'single') return { risers, perFlight: risers, flights: 1 };
  return { risers, perFlight: Math.ceil(risers / 2), flights: 2 };
}

/**
 * Footprint of a core module at a floor-to-floor: `across` is the stair RUN plus its landing(s) measured across the
 * bar, `along` is the flights side by side plus the lift bank plus the lobby.
 */
export function footprintOf(m: CoreModule, f2f: number): CoreFootprint {
  const { perFlight, flights } = flightsFor(m.stair, f2f, m.riserMax);
  const run = perFlight * m.treadMin;
  const across = run + m.landing * (flights === 1 ? 2 : 1) + 0.1;
  // one flight across the bar = one flight width; a dog-leg or a scissor pair sits two flights side by side
  const stairAlong = flights === 1 ? m.stairWidth + 0.3 : 2 * m.stairWidth + 0.1;
  const liftAlong = m.lifts > 0 ? LIFT_SLICE : 0;
  const lobbyAlong = m.lobby ? LOBBY_MIN : 0;
  return {
    along: round3(stairAlong + liftAlong + lobbyAlong),
    across: round3(across),
  };
}

const SHAFT_PURPOSES: ShaftDef['purpose'][] = ['plumbing', 'mechanical', 'electrical'];

function shaftSlotsFor(trash: boolean): CoreModule['shaftSlots'] {
  const slots: CoreModule['shaftSlots'] = [];
  const n = SHAFT_PURPOSES.length + (trash ? 1 : 0);
  const pitch = 1 / n;
  for (let i = 0; i < SHAFT_PURPOSES.length; i++) {
    slots.push({ purpose: SHAFT_PURPOSES[i], atFrac: round3(pitch * (i + 0.5)), wFrac: round3(pitch * 0.82), dFrac: 0.34 });
  }
  if (trash) {
    slots.push({ purpose: 'trash', atFrac: round3(pitch * (SHAFT_PURPOSES.length + 0.5)), wFrac: round3(pitch * 0.82), dFrac: 0.42 });
  }
  return slots;
}

function portsFor(lifts: number, lobby: boolean, slots: CoreModule['shaftSlots']): Port[] {
  const ports: Port[] = [
    { id: 'corridor-connect', kind: 'corridor-connect', side: 'front', atFrac: 0.5, width: 1.4, required: true },
    { id: 'exit', kind: 'exit', side: 'front', atFrac: 0.18, width: 0.95, required: true },
  ];
  if (lifts > 0) ports.push({ id: 'lift-lobby', kind: 'corridor-connect', side: 'front', atFrac: lobby ? 0.82 : 0.6, width: 1.4, required: false });
  for (const s of slots) {
    ports.push({ id: `shaft.${s.purpose}`, kind: 'shaft', side: 'interior', atFrac: s.atFrac, width: 0, purpose: s.purpose, required: s.purpose !== 'trash' });
  }
  ports.push({ id: 'riser', kind: 'riser', side: 'interior', atFrac: slots[0]?.atFrac ?? 0.2, width: 0, required: false });
  return ports;
}

/** Stair configuration × lift count. Nine records; the placer picks by lifts required and the footprint that fits. */
const CONFIGS: { stair: StairConfig; stairCount: 1 | 2; lifts: number }[] = [
  { stair: 'single', stairCount: 1, lifts: 0 },
  { stair: 'single', stairCount: 1, lifts: 1 },
  { stair: 'dog-leg', stairCount: 1, lifts: 0 },
  { stair: 'dog-leg', stairCount: 1, lifts: 1 },
  { stair: 'dog-leg', stairCount: 1, lifts: 2 },
  { stair: 'dog-leg', stairCount: 1, lifts: 3 },
  { stair: 'scissor', stairCount: 2, lifts: 2 },
  { stair: 'scissor', stairCount: 2, lifts: 3 },
  { stair: 'scissor', stairCount: 2, lifts: 4 },
];

export function buildCoreModules(): CoreModule[] {
  const out: CoreModule[] = [];
  for (const c of CONFIGS) {
    const lobby = c.lifts > 0;
    const slots = shaftSlotsFor(true);
    const draft: CoreModule = {
      id: coreModuleId(c.stair, c.lifts),
      kind: 'core',
      name: `${c.stair === 'dog-leg' ? 'Dog-leg' : c.stair === 'scissor' ? 'Scissor' : 'Single-flight'} stair core${c.lifts > 0 ? ` + ${c.lifts} lift${c.lifts > 1 ? 's' : ''}` : ''}`,
      // filled from the footprint sweep below
      frontage: { min: 0, max: 0 },
      depth: { min: 0, max: 0 },
      ports: portsFor(c.lifts, lobby, slots),
      mirrorable: true,
      patterns: ['ARC-04', 'ARC-32', 'XD-04'],
      stair: c.stair,
      stairCount: c.stairCount,
      lifts: c.lifts,
      shaftSlots: slots,
      lobby,
      stairWidth: STAIR_RULES.width,
      riserMax: STAIR_RULES.riserMax,
      treadMin: STAIR_RULES.treadMin,
      landing: STAIR_RULES.landing,
    };
    // the admissible footprint band over the floor-to-floor range the generator can produce (2.6 … 4.5 m)
    const lo = footprintOf(draft, 2.6);
    const hi = footprintOf(draft, 4.5);
    draft.frontage = { min: round3(Math.min(lo.along, hi.along)), max: round3(Math.max(lo.along, hi.along) + 2.4) };
    draft.depth = { min: round3(Math.min(lo.across, hi.across)), max: round3(Math.max(lo.across, hi.across) + 3.0) };
    out.push(draft);
  }
  return out;
}

/** Best core module for a required lift count and stair count, or the widest one available */
export function pickCoreModule(cores: readonly CoreModule[], lifts: number, scissor: boolean): CoreModule | undefined {
  const want = cores.filter(c => (scissor ? c.stair === 'scissor' : c.stair !== 'scissor'));
  const pool = want.length > 0 ? want : cores;
  let best: CoreModule | undefined;
  for (const c of pool) {
    if (c.lifts < lifts) continue;
    if (!best || c.lifts < best.lifts || (c.lifts === best.lifts && c.id < best.id)) best = c;
  }
  if (best) return best;
  // nothing carries that many lifts: take the one with the most
  for (const c of pool) if (!best || c.lifts > best.lifts) best = c;
  return best;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
