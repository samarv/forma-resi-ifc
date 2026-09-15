/**
 * ELE-09 Sun on the Roof   — fill the architect's PV zone with modules (NEC 690, MCS/AS 5033)
 * ELE-10 Charge Where You Park — an EV charger at the head of every EV-ready stall (NEC 625,
 *                                UK Building Regs Part S, AS/NZS 3000 §7.9)
 */
import type { Rect, Vec2, Vec3 } from '../../core/types.ts';
import { rectCenter, rectUnionBounds } from '../../core/geometry.ts';
import { ROOF_STOREY } from '../../core/ids.ts';
import { addDevice, doorsOnFace, facesOf, windowsOnFace, type ElecCtx } from './internal.ts';
import { anchorOnFace, bestFreeSpan, blockedSpans, nearestFace } from './placement.ts';

const PANEL_W = 1.0;
const PANEL_D = 1.7;
const ROW_GAP = 0.5;
const KW_PER_PANEL = 0.4;

export interface PvResult {
  panelRects: Rect[];
  kwDc: number;
  zone: Rect | null;
  coverage: number;
}

/** Rows of modules inside pvZone, capped so the array does not exceed the building demand */
export function generatePv(ec: ElecCtx, demandVa: number): PvResult {
  const zone = ec.arch.roof?.pvZone ?? null;
  if (!zone || zone.w < PANEL_W || zone.h < PANEL_D) return { panelRects: [], kwDc: 0, zone, coverage: 0 };
  const rowsAlongX = zone.w >= zone.h;
  const alongLen = rowsAlongX ? zone.w : zone.h;
  const acrossLen = rowsAlongX ? zone.h : zone.w;
  const rows = Math.floor((acrossLen + ROW_GAP) / (PANEL_D + ROW_GAP));
  const perRow = Math.floor(alongLen / PANEL_W);
  if (rows < 1 || perRow < 1) return { panelRects: [], kwDc: 0, zone, coverage: 0 };
  const maxPanels = Math.max(1, Math.floor(demandVa / 1000 / KW_PER_PANEL));
  const rects: Rect[] = [];
  for (let j = 0; j < rows && rects.length < maxPanels; j++) {
    for (let i = 0; i < perRow && rects.length < maxPanels; i++) {
      rects.push(rowsAlongX
        ? { x: zone.x + i * PANEL_W, y: zone.y + j * (PANEL_D + ROW_GAP), w: PANEL_W, h: PANEL_D }
        : { x: zone.x + j * (PANEL_D + ROW_GAP), y: zone.y + i * PANEL_W, w: PANEL_D, h: PANEL_W });
    }
  }
  const rotation = rowsAlongX ? 0 : -Math.PI / 2;
  for (const r of rects) {
    const c = rectCenter(r);
    addDevice(ec, ROOF_STOREY, 'pv-panel', [c[0], c[1], 0.3], rotation, {
      want: 'pv', va: KW_PER_PANEL * 1000, watts: 0,
      name: `PV module ${Math.round(KW_PER_PANEL * 1000)} Wp`,
      note: 'ELE-09 flat-mounted module, 0.5 m row gaps for access and shading',
    });
  }
  const kwDc = Math.round(rects.length * KW_PER_PANEL * 10) / 10;
  const coverage = zone.w * zone.h > 0 ? (rects.length * PANEL_W * PANEL_D) / (zone.w * zone.h) : 0;
  return { panelRects: rects, kwDc, zone, coverage };
}

export interface EvResult {
  chargers: number;
  storey: string;
  near: Vec2 | null;
}

/** One charger at the head of every stall flagged 'ev', plus one per private garage */
export function generateEv(ec: ElecCtx): EvResult {
  const lot = ec.ctx.site.parking;
  let chargers = 0;
  let storey = ec.storeys[0]?.id ?? 'L01';
  let near: Vec2 | null = null;
  if (lot && lot.spaces.length > 0) {
    const bounds = rectUnionBounds([...lot.spaces.map(s => s.rect), ...lot.aisles]);
    const lotCenter = rectCenter(bounds);
    for (const space of lot.spaces) {
      if (space.type !== 'ev') continue;
      const c = rectCenter(space.rect);
      const longAxisY = space.rect.h >= space.rect.w;
      const away = longAxisY ? Math.sign(c[1] - lotCenter[1]) || 1 : Math.sign(c[0] - lotCenter[0]) || 1;
      const head: Vec2 = longAxisY
        ? [c[0], space.rect.y + (away > 0 ? space.rect.h : 0) + away * 0.15]
        : [space.rect.x + (away > 0 ? space.rect.w : 0) + away * 0.15, c[1]];
      const anchor: Vec3 = [head[0], head[1], 0];
      addDevice(ec, space.storey || lot.storey, 'ev-charger', anchor, longAxisY ? 0 : Math.PI / 2, {
        want: 'ev',
        name: `EV charger 7.2 kW (stall ${space.id})`,
        note: 'ELE-10 charger at the head of the stall; energy management per NEC 625.42',
      });
      chargers++;
      storey = space.storey || lot.storey;
      near = head;
    }
  }
  for (const room of ec.arch.rooms) {
    if (room.type !== 'garage') continue;
    const faces = facesOf(ec, room);
    const hit = bestFreeSpan(faces, f => blockedSpans(f, doorsOnFace(ec, f), windowsOnFace(ec, f), ec.wallById, 2.2), 0.5)
      ?? (nearestFace(faces, rectCenter(room.rect), 0.5) ? { face: nearestFace(faces, rectCenter(room.rect), 0.5)!.face, span: { a: 0, b: 1 } } : null);
    if (!hit) continue;
    const onFace = anchorOnFace(hit.face, (hit.span.a + hit.span.b) / 2, 0);
    const inFront: Vec3 = [onFace[0] + hit.face.inward[0] * 0.1, onFace[1] + hit.face.inward[1] * 0.1, 0];
    addDevice(ec, room.storey, 'ev-charger', inFront, hit.face.rotation, {
      roomId: room.id, unitId: room.unitId, want: 'ev',
      name: 'EV charger 7.2 kW (garage)',
      note: 'ELE-10 one wall-mounted charger per private garage',
    });
    chargers++;
    storey = room.storey;
    near = rectCenter(room.rect);
  }
  return { chargers, storey, near };
}
