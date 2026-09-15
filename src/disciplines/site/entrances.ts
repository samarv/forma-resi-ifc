/**
 * Entrances — SIT-02 Building Faces the Street (with SIT-03 for a courtyard passage).
 *
 * Order matters to the architecture module: 'unit' entrances are emitted in ascending X so
 * unit doors can be aligned to them one for one. Garage entrances are appended later by
 * `parking.ts`, so they never disturb that order.
 */
import type {
  BuildingSpec, TypologyDef, Rng, Vec2, Side, Entrance, PatternApplication, MassingBar,
} from '../../core/types.ts';
import { round } from '../../core/geometry.ts';
import type { IdFactory } from '../../core/ids.ts';
import { SITE_STOREY } from '../../core/ids.ts';
import type { SiteFrame, MassingResult } from './massing.ts';
import { integralGarageWidth } from './parking.ts';
import { clampNum } from './util.ts';

export interface EntranceResult {
  entrances: Entrance[];
  apps: PatternApplication[];
  /** X of each direct-access dwelling's front door, in order along +X */
  doorXs: number[];
}

export function buildEntrances(
  spec: BuildingSpec,
  typology: TypologyDef,
  frame: SiteFrame,
  m: MassingResult,
  rng: Rng,
  ids: IdFactory,
  warnings: string[],
): EntranceResult {
  const entrances: Entrance[] = [];
  const apps: PatternApplication[] = [];
  const doorXs: number[] = [];
  const bars = m.massing.bars;
  // The ground floor (podium when there is one) is what actually meets the street.
  const groundFrontY = m.footprintRect.y;

  if (typology.access === 'direct') {
    const bar = bars[0];
    const dwellings = Math.max(1, m.dwellingsAcross);   // one front door per frontage bay
    const frontage = m.dwellingFrontage;
    const garageAttached = (spec.site.parking?.type ?? typology.parking) === 'garage-attached';
    if (dwellings === 1) {
      // One dwelling: the front door is the main entrance, set off-centre away from the garage.
      const rightRoom = frame.boundary.w - (bar.rect.x + bar.rect.w);
      const doorFrac = rightRoom >= bar.rect.x ? 0.35 : 0.65;
      const x = bar.rect.x + bar.rect.w * doorFrac;
      doorXs.push(x);
      entrances.push({ id: ids.next(SITE_STOREY, 'ENT'), position: [x, bar.rect.y], side: 'front', type: 'main' });
      entrances.push({ id: ids.next(SITE_STOREY, 'ENT'), position: [x, bar.rect.y], side: 'front', type: 'unit' });
    } else {
      // Exactly one door per house slice, the slices evenly spaced along the bar: architecture
      // divides the same bar into the same `dwellingsAcross` slices, so door k belongs to house k.
      // Within its slice the door sits at the centre of the part of the frontage the house
      // actually has — past the garage door on a garage-attached row, mid-slice otherwise.
      const gw = garageAttached ? integralGarageWidth(frontage) + 0.3 : 0;
      for (let i = 0; i < dwellings; i++) {
        const base = bar.rect.x + i * frontage;
        if (base + frontage > bar.rect.x + bar.rect.w + 1e-6) break;
        const x = base + gw + (frontage - gw) / 2;
        doorXs.push(x);
        entrances.push({ id: ids.next(SITE_STOREY, 'ENT'), position: [x, bar.rect.y], side: 'front', type: 'unit' });
      }
      if (doorXs.length !== dwellings) {
        // Would leave architecture's houses without doors to align to.
        warnings.push(`Only ${doorXs.length} of ${dwellings} front doors fit on the ${bar.rect.w.toFixed(1)} m street face (SIT-02).`);
      }
    }
    apps.push({
      patternId: 'SIT-02',
      storey: SITE_STOREY,
      elementIds: entrances.map(e => e.id),
      params: {
        dwellings, unitFrontage: round(frontage), doors: doorXs.length, garageAttached,
        template: m.dwellingTemplate, netDepth: round(m.dwellingNetDepth),
      },
      note: 'One front door per dwelling on the street face, exported in ascending X.',
    });
  } else {
    const main = mainEntrancePosition(m, groundFrontY);
    entrances.push({ id: ids.next(SITE_STOREY, 'ENT'), position: main.pos, side: main.side, type: 'main' });
    apps.push({
      patternId: 'SIT-02',
      storey: SITE_STOREY,
      elementIds: [entrances[0].id],
      params: { atCore: main.coreId ?? 'plate-centre', x: round(main.pos[0]), y: round(main.pos[1]), side: main.side },
      note: 'Shared entrance on the street face at the principal core.',
    });
  }

  // Service entrance at the rear, at the end of the rearmost bar furthest from the main door.
  const rearBar = bars.reduce((a, b) => (b.rect.y + b.rect.h > a.rect.y + a.rect.h ? b : a), bars[0]);
  const mainX = entrances.length > 0 ? entrances[0].position[0] : frame.boundary.w / 2;
  const serviceFrac = mainX > rearBar.rect.x + rearBar.rect.w / 2 ? 0.2 : 0.8;
  entrances.push({
    id: ids.next(SITE_STOREY, 'ENT'),
    position: [rearBar.rect.x + rearBar.rect.w * serviceFrac, rearBar.rect.y + rearBar.rect.h],
    side: 'rear',
    type: 'service',
  });

  // SIT-03: a courtyard must be crossed — one passage through the street-facing bar.
  if (m.courtyardRect && m.massing.shape === 'O') {
    const frontBar = bars.reduce((a, b) => (b.rect.y < a.rect.y ? b : a), bars[0]);
    const x = clampNum(frontBar.rect.x + frontBar.rect.w / 2, frontBar.rect.x + 2, frontBar.rect.x + frontBar.rect.w - 2);
    const e: Entrance = { id: ids.next(SITE_STOREY, 'ENT'), position: [x, frontBar.rect.y], side: 'front', type: 'courtyard' };
    entrances.push(e);
    apps.push({
      patternId: 'SIT-03',
      storey: SITE_STOREY,
      elementIds: [e.id],
      params: { passages: 1, x: round(x), throughBar: frontBar.id },
      note: 'Passage from the street into the courtyard through the front bar.',
    });
  }

  void rng;
  return { entrances, apps, doorXs };
}

/** Main entrance on the ground-floor street face at the principal core (or the plate centre). */
function mainEntrancePosition(m: MassingResult, groundFrontY: number): { pos: Vec2; side: Side; coreId?: string } {
  const bars = m.massing.bars;
  const byId = new Map<string, MassingBar>(bars.map(b => [b.id, b]));
  const cores = m.massing.cores;
  if (cores.length > 0) {
    const ranked = [...cores].sort((a, b) => {
      const ba = byId.get(a.barId), bb = byId.get(b.barId);
      const ra = ba ? (ba.axis === 'x' ? 0 : 1) : 2;
      const rb = bb ? (bb.axis === 'x' ? 0 : 1) : 2;
      if (ra !== rb) return ra - rb;
      const ya = ba ? ba.rect.y : 0, yb = bb ? bb.rect.y : 0;
      if (Math.abs(ya - yb) > 1e-6) return ya - yb;
      return a.rect.x - b.rect.x;
    });
    const core = ranked[0];
    const bar = byId.get(core.barId);
    if (bar && bar.axis === 'x') {
      return { pos: [core.rect.x + core.rect.w / 2, groundFrontY], side: 'front', coreId: core.id };
    }
    if (bar) {
      const left = bar.rect.x < m.plateRect.x + m.plateRect.w / 2;
      return { pos: [left ? bar.rect.x : bar.rect.x + bar.rect.w, core.rect.y + core.rect.h / 2], side: left ? 'left' : 'right', coreId: core.id };
    }
  }
  return { pos: [m.plateRect.x + m.plateRect.w / 2, groundFrontY], side: 'front' };
}
