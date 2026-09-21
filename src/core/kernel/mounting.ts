/**
 * Standard mounting heights (storey-local Z, metres). Region-neutral defaults that satisfy the NEC/ADA and
 * BS 7671 / Approved Document M ranges. Moved verbatim from `core/coordination.ts` (which re-exports it until wave 3).
 */
export const MOUNTING = {
  receptacle: 0.4,
  counterReceptacle: 1.1,
  switch: 1.2,
  thermostat: 1.5,
  panelBottom: 1.2,
  wallLight: 2.0,
  ceilingLightDrop: 0.0,
  smokeAlarmDrop: 0.0,
  windowSill: 0.9,
  doorHeight: 2.1,
  unitEntryDoorHeight: 2.1,
  lavatoryRim: 0.85,
  showerValve: 1.1,
  hoseBibb: 0.5,
  sprinklerHeadDrop: 0.05,
} as const;

export type MountingKey = keyof typeof MOUNTING;
