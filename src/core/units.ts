/**
 * Display-unit conversion. The model is always metric; only formatting converts.
 */
export const M_TO_FT = 3.28084;
export const M2_TO_FT2 = 10.7639;
export const M3_TO_FT3 = 35.3147;
export const HA_TO_ACRE = 2.47105;
export const KW_TO_TON = 0.284345;
export const LS_TO_CFM = 2.11888;

export type DisplayUnits = 'metric' | 'imperial';

export function fmtLength(m: number, u: DisplayUnits, decimals = 2): string {
  if (u === 'imperial') {
    const ft = m * M_TO_FT;
    const whole = Math.floor(ft);
    const inches = Math.round((ft - whole) * 12);
    return inches === 12 ? `${whole + 1}'-0"` : `${whole}'-${inches}"`;
  }
  return `${m.toFixed(decimals)} m`;
}

export function fmtArea(m2: number, u: DisplayUnits, decimals = 1): string {
  return u === 'imperial' ? `${Math.round(m2 * M2_TO_FT2).toLocaleString('en-US')} sf` : `${m2.toFixed(decimals)} m²`;
}

export function fmtDensity(dph: number, u: DisplayUnits): string {
  return u === 'imperial' ? `${(dph / HA_TO_ACRE).toFixed(1)} du/ac` : `${dph.toFixed(0)} dph`;
}

export function fmtNumber(v: number, decimals = 1): string {
  return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toFixed(decimals);
}

export function feet(ft: number, inches = 0): number {
  return (ft + inches / 12) / M_TO_FT;
}
