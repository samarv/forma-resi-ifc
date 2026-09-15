/**
 * Ground plane: paths, yards, gardens, courtyard, trees and boundary fences.
 *
 * Rules implemented here: SIT-10 Trees and Ground, SIT-11 Entrance Transition,
 * SIT-12 Hierarchy of Open Space (and the courtyard zone from SIT-03).
 *
 * Everything is built by subtracting the hard stuff (buildings, parking, driveways, paths)
 * from the yards, so soft landscape never overlaps hardscape.
 */
import type {
  BuildingSpec, TypologyDef, Rng, Rect, Vec2, LandscapeZone, ModelElement, Entrance, PatternApplication,
} from '../../core/types.ts';
import { rectToPolygon, relativeTo, translatePolygon, polygonArea, round } from '../../core/geometry.ts';
import type { IdFactory } from '../../core/ids.ts';
import { SITE_STOREY } from '../../core/ids.ts';
import type { SiteFrame, MassingResult } from './massing.ts';
import { pavingElement } from './parking.ts';
import { clampNum, subtractRects, octagon, pset, SITE_COLORS } from './util.ts';

const MAIN_PATH_W = 2.0;
const UNIT_PATH_W = 1.5;
const PLANTING_STRIP = 1.2;
const TREE_SPACING_MIN = 8.0;
const TREE_SPACING_MAX = 10.0;
const TREE_CLEARANCE = 1.0;
const MAX_TREES = 60;
const FENCE_HEIGHT = 1.8;
const ZONE_THICKNESS = 0.05;

export interface LandscapeResult {
  zones: LandscapeZone[];
  paths: Rect[];
  elements: ModelElement[];
  apps: PatternApplication[];
  treeCount: number;
  landscapeArea: number;
  openSpaceArea: number;
}

export function buildLandscape(
  spec: BuildingSpec,
  typology: TypologyDef,
  frame: SiteFrame,
  m: MassingResult,
  entrances: Entrance[],
  hardscapeIn: Rect[],
  rng: Rng,
  ids: IdFactory,
): LandscapeResult {
  const zones: LandscapeZone[] = [];
  const elements: ModelElement[] = [];
  const apps: PatternApplication[] = [];
  const paths: Rect[] = [];
  const hard: Rect[] = [...hardscapeIn];
  const detail = spec.options.detail;
  const B = frame.boundary;

  // --- SIT-11: a path from the street to every street-facing entrance ------
  const pathTargets = entrances.filter(e => e.side === 'front' && e.type !== 'garage');
  for (const e of pathTargets) {
    const w = e.type === 'unit' ? UNIT_PATH_W : MAIN_PATH_W;
    const y2 = e.position[1];
    if (y2 <= 0.6) continue;                                  // build-to line: no front path
    const r: Rect = { x: clampNum(e.position[0] - w / 2, 0, Math.max(0, B.w - w)), y: 0, w, h: y2 };
    if (hard.some(h => overlapArea(r, h) > 0.4 * r.w * r.h)) continue;   // already paved (crossover)
    if (paths.some(p => Math.abs(p.x - r.x) < 1.2)) continue;            // merge near-coincident paths
    paths.push(r);
    hard.push(r);
    elements.push(pavingElement(ids, r, e.type === 'unit' ? 'Front path' : 'Entrance path', SITE_COLORS.paving, ['SIT-11']));
  }
  apps.push({
    patternId: 'SIT-11',
    storey: SITE_STOREY,
    params: { paths: paths.length, mainPathWidth: MAIN_PATH_W, unitPathWidth: UNIT_PATH_W, entrances: entrances.length },
  });

  // --- obstacle set for the yards ------------------------------------------
  const obstacles: Rect[] = [...hard];
  for (const b of m.massing.bars) obstacles.push(b.rect);
  if (m.podiumRect) obstacles.push(m.podiumRect);
  if (m.existingHouseRect) obstacles.push(m.existingHouseRect);

  const frontY = m.footprintRect.y;
  const rearY = m.footprintRect.y + m.footprintRect.h;
  const leftX = m.footprintRect.x;
  const rightX = m.footprintRect.x + m.footprintRect.w;

  // --- front yard: planting strip at the street, lawn behind it (SIT-10) ---
  if (frontY > 0.8) {
    const strip = Math.min(PLANTING_STRIP, frontY * 0.5);
    addZones(zones, elements, ids, subtractRects({ x: 0, y: 0, w: B.w, h: strip }, obstacles), 'planting', ['SIT-10'], 'Street planting strip');
    if (frontY - strip > 0.8) {
      addZones(zones, elements, ids, subtractRects({ x: 0, y: strip, w: B.w, h: frontY - strip }, obstacles), 'lawn', ['SIT-10', 'SIT-12'], 'Front lawn');
    }
  }

  // --- rear yard: private gardens per dwelling, else one communal garden ---
  let hierarchyRecorded = false;
  if (rearY < B.h - 0.8) {
    hierarchyRecorded = true;
    const yard: Rect = { x: 0, y: rearY, w: B.w, h: B.h - rearY };
    if (typology.access === 'direct' && m.dwellingsAcross >= 1) {
      const bar = m.massing.bars[0];
      const frontage = m.dwellingFrontage;
      let gardens = 0;
      for (let i = 0; i < m.dwellingsAcross; i++) {
        const strip: Rect = { x: bar.rect.x + i * frontage, y: yard.y, w: frontage, h: yard.h };
        if (strip.x + strip.w > B.w + 1e-6) break;
        const pieces = subtractRects(strip, obstacles, 1.0);
        gardens += addZones(zones, elements, ids, pieces, 'private-garden', ['SIT-12', 'SIT-04'], `Private garden ${i + 1}`);
      }
      // Whatever is left either side of the row stays as lawn.
      const flanks = subtractRects(yard, [...obstacles, { x: bar.rect.x, y: yard.y, w: bar.rect.w, h: yard.h }], 1.0);
      addZones(zones, elements, ids, flanks, 'lawn', ['SIT-10'], 'Rear lawn');
      apps.push({
        patternId: 'SIT-12',
        storey: SITE_STOREY,
        params: {
          privateGardens: gardens, dwellings: m.dwellings, dwellingsAcross: m.dwellingsAcross, gardenDepth: round(yard.h),
          gardenArea: round(zones.filter(z => z.type === 'private-garden').reduce((s, z) => s + z.area, 0), 1),
        },
      });
    } else {
      const pieces = subtractRects(yard, obstacles, 1.0);
      const n = addZones(zones, elements, ids, pieces, 'communal-garden', ['SIT-12'], 'Communal garden');
      apps.push({
        patternId: 'SIT-12',
        storey: SITE_STOREY,
        params: {
          communalZones: n, units: m.estimatedUnits,
          areaPerUnit: round(zones.filter(z => z.type === 'communal-garden').reduce((s, z) => s + z.area, 0) / Math.max(1, m.estimatedUnits), 2),
        },
      });
    }
  }

  // --- side yards ----------------------------------------------------------
  if (leftX > 0.8) {
    addZones(zones, elements, ids, subtractRects({ x: 0, y: frontY, w: leftX, h: Math.max(0, rearY - frontY) }, obstacles), leftX < 3 ? 'planting' : 'lawn', ['SIT-10'], 'Side yard (left)');
  }
  if (rightX < B.w - 0.8) {
    const w = B.w - rightX;
    addZones(zones, elements, ids, subtractRects({ x: rightX, y: frontY, w, h: Math.max(0, rearY - frontY) }, obstacles), w < 3 ? 'planting' : 'lawn', ['SIT-10'], 'Side yard (right)');
  }

  // --- courtyard (SIT-03) --------------------------------------------------
  if (m.courtyardRect) {
    const n = addZones(zones, elements, ids, [m.courtyardRect], 'courtyard', ['SIT-03', 'SIT-12'], 'Courtyard');
    if (!hierarchyRecorded && n > 0) {
      hierarchyRecorded = true;
      apps.push({
        patternId: 'SIT-12',
        storey: SITE_STOREY,
        params: {
          communalZones: n, units: m.estimatedUnits,
          areaPerUnit: round(m.courtyardRect.w * m.courtyardRect.h / Math.max(1, m.estimatedUnits), 2),
        },
        note: 'The courtyard is the whole of the communal open space; there is no rear yard.',
      });
    }
  }
  if (!hierarchyRecorded) {
    apps.push({
      patternId: 'SIT-12',
      storey: SITE_STOREY,
      params: { communalZones: 0, units: m.estimatedUnits, areaPerUnit: 0 },
      note: 'Building occupies the whole envelope: no graded open space on this site.',
    });
  }

  // --- trees (SIT-10) ------------------------------------------------------
  const treePositions = treeGrid(frame, m, rng);
  let treeCount = 0;
  for (const p of treePositions) {
    if (treeCount >= MAX_TREES) break;
    if (hard.some(h => pointNear(p, h, TREE_CLEARANCE))) continue;
    if (m.massing.bars.some(b => pointNear(p, b.rect, 0.5))) continue;
    if (m.existingHouseRect && pointNear(p, m.existingHouseRect, 0.5)) continue;
    // Trees may stand in a courtyard, but not on a podium deck.
    const inCourtyard = m.courtyardRect ? pointNear(p, m.courtyardRect, -0.5) : false;
    if (m.podiumRect && pointNear(p, m.podiumRect, 0.5) && !inCourtyard) continue;
    const canopy = 6.0 + rng.next() * 3.0;
    const poly = translatePolygon(octagon(0.4), p);
    const zone: LandscapeZone = { id: ids.next(SITE_STOREY, 'TREE'), type: 'tree', polygon: poly, area: polygonArea(poly) };
    zones.push(zone);
    elements.push({
      id: ids.next(SITE_STOREY, 'VEG'),
      discipline: 'site',
      ifcType: 'IfcGeographicElement',
      predefinedType: 'USERDEFINED',
      name: `Tree ${treeCount + 1}`,
      objectType: 'Tree',
      storey: SITE_STOREY,
      geometry: { kind: 'prism', position: [p[0], p[1], 0], profile: relativeTo(translatePolygon(octagon(1.8), p), p), height: canopy },
      psets: [pset('Forma_Site', { Category: 'Landscape', Element: 'Tree', CanopyHeight: round(canopy), CanopyRadius: 1.8 })],
      color: SITE_COLORS.canopy,
      patterns: ['SIT-10'],
      tags: ['landscape', 'tree'],
    });
    if (detail === 'high') {
      elements.push({
        id: ids.next(SITE_STOREY, 'TRNK'),
        discipline: 'site',
        ifcType: 'IfcGeographicElement',
        predefinedType: 'USERDEFINED',
        name: `Tree trunk ${treeCount + 1}`,
        objectType: 'TreeTrunk',
        storey: SITE_STOREY,
        geometry: { kind: 'column', position: [p[0], p[1], 0], width: 0.3, depth: 0.3, height: canopy * 0.45, shape: 'circle' },
        psets: [pset('Forma_Site', { Category: 'Landscape', Element: 'TreeTrunk' })],
        color: SITE_COLORS.trunk,
        patterns: ['SIT-10'],
        tags: ['landscape', 'tree'],
      });
    }
    treeCount++;
  }

  // --- boundary fence for houses (SIT-12) ----------------------------------
  if (detail === 'high' && typology.access === 'direct') {
    const y0 = clampNum(frontY, 0, B.h);
    const runs: [Vec2, Vec2][] = [
      [[0.05, y0], [0.05, B.h - 0.05]],
      [[B.w - 0.05, y0], [B.w - 0.05, B.h - 0.05]],
      [[0.05, B.h - 0.05], [B.w - 0.05, B.h - 0.05]],
    ];
    for (const [a, b] of runs) {
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1) continue;
      elements.push({
        id: ids.next(SITE_STOREY, 'FENCE'),
        discipline: 'site',
        ifcType: 'IfcWall',
        predefinedType: 'USERDEFINED',
        name: 'Boundary fence',
        objectType: 'Fence',
        storey: SITE_STOREY,
        geometry: { kind: 'wall', start: [a[0], a[1], 0], end: [b[0], b[1], 0], thickness: 0.1, height: FENCE_HEIGHT },
        psets: [pset('Forma_Site', { Category: 'Boundary', Element: 'Fence', Height: FENCE_HEIGHT })],
        color: SITE_COLORS.fence,
        patterns: ['SIT-12'],
        tags: ['boundary', 'fence'],
      });
    }
  }

  const siteArea = B.w * B.h;
  const openSpaceArea = Math.max(0, siteArea - m.massing.footprintArea);
  const landscapeArea = zones.filter(z => z.type !== 'paving').reduce((s, z) => s + z.area, 0);
  apps.push({
    patternId: 'SIT-10',
    storey: SITE_STOREY,
    params: {
      trees: treeCount, spacingMin: TREE_SPACING_MIN, spacingMax: TREE_SPACING_MAX,
      landscapeArea: round(landscapeArea, 1), openSpaceArea: round(openSpaceArea, 1),
      landscapeRatio: round(openSpaceArea > 0 ? landscapeArea / openSpaceArea : 0, 3),
      plantingStripDepth: PLANTING_STRIP,
    },
  });

  return { zones, paths, elements, apps, treeCount, landscapeArea, openSpaceArea };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function addZones(
  zones: LandscapeZone[],
  elements: ModelElement[],
  ids: IdFactory,
  rects: Rect[],
  type: LandscapeZone['type'],
  patterns: string[],
  name: string,
): number {
  let n = 0;
  for (const r of rects) {
    if (r.w < 0.8 || r.h < 0.8) continue;
    const polygon = rectToPolygon(r);
    const area = polygonArea(polygon);
    const id = ids.next(SITE_STOREY, 'ZONE');
    zones.push({ id, type, polygon, area });
    elements.push({
      id: ids.next(SITE_STOREY, 'LAND'),
      discipline: 'site',
      ifcType: 'IfcGeographicElement',
      predefinedType: 'TERRAIN',
      name: `${name}${n > 0 ? ` ${n + 1}` : ''}`,
      objectType: type,
      storey: SITE_STOREY,
      geometry: { kind: 'prism', position: [r.x, r.y, 0], profile: relativeTo(polygon, [r.x, r.y]), height: ZONE_THICKNESS },
      psets: [pset('Forma_Site', { Category: 'Landscape', ZoneType: type, Area: round(area, 2), ZoneId: id })],
      color: colorFor(type),
      patterns,
      tags: ['landscape', type],
    });
    n++;
  }
  return n;
}

function colorFor(type: LandscapeZone['type']): [number, number, number] {
  switch (type) {
    case 'lawn': return SITE_COLORS.lawn;
    case 'planting': return SITE_COLORS.planting;
    case 'courtyard': return SITE_COLORS.courtyard;
    case 'private-garden': return SITE_COLORS.privateGarden;
    case 'communal-garden': return SITE_COLORS.communalGarden;
    case 'playground': return SITE_COLORS.playground;
    case 'bioswale': return SITE_COLORS.bioswale;
    case 'paving': return SITE_COLORS.paving;
    default: return SITE_COLORS.canopy;
  }
}

/**
 * Candidate tree positions at 8–10 m centres: down the street planting strip, down both side
 * setbacks, along the rear boundary and around any courtyard. Callers filter out positions
 * that foul hardscape or buildings.
 */
function treeGrid(frame: SiteFrame, m: MassingResult, rng: Rng): Vec2[] {
  const out: Vec2[] = [];
  const B = frame.boundary;
  const spacing = TREE_SPACING_MIN + rng.next() * (TREE_SPACING_MAX - TREE_SPACING_MIN);
  const frontY = m.footprintRect.y;
  const rearY = m.footprintRect.y + m.footprintRect.h;

  if (frontY >= 1.5) {
    const y = clampNum(frontY * 0.5, 0.8, frontY - 0.8);
    for (let x = spacing / 2; x < B.w - 0.8; x += spacing) out.push([x, y]);
  }
  const leftBand = m.footprintRect.x;
  if (leftBand >= 1.6) {
    const x = clampNum(leftBand * 0.5, 0.8, leftBand - 0.8);
    for (let y = frontY + spacing / 2; y < rearY; y += spacing) out.push([x, y]);
  }
  const rightBand = B.w - (m.footprintRect.x + m.footprintRect.w);
  if (rightBand >= 1.6) {
    const x = clampNum(B.w - rightBand * 0.5, 0.8, B.w - 0.8);
    for (let y = frontY + spacing / 2; y < rearY; y += spacing) out.push([x, y]);
  }
  if (B.h - rearY >= 2.5) {
    const y = clampNum(B.h - 1.5, 0.8, B.h - 0.8);
    for (let x = spacing / 2; x < B.w - 0.8; x += spacing) out.push([x, y]);
  }
  if (m.courtyardRect) {
    const c = m.courtyardRect;
    const inner = { x: c.x + 2.5, y: c.y + 2.5, w: Math.max(0, c.w - 5), h: Math.max(0, c.h - 5) };
    for (let x = inner.x; x <= inner.x + inner.w; x += spacing) {
      for (let y = inner.y; y <= inner.y + inner.h; y += spacing) out.push([x, y]);
    }
  }
  return out;
}

function pointNear(p: Vec2, r: Rect, pad: number): boolean {
  return p[0] >= r.x - pad && p[0] <= r.x + r.w + pad && p[1] >= r.y - pad && p[1] <= r.y + r.h + pad;
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
