/**
 * Step 7 — storm drainage (PLB-06 Roof Drains at Low Points, Downpipes at Cores).
 *
 * SHAFT CORNER CONVENTION (agreed across MEP disciplines):
 *   mechanical  → shaft CENTRE
 *   plumbing    → shaft MIN corner + (0.15, 0.15)   ← this module
 *   electrical  → shaft MAX corner − (0.15, 0.15)
 */
import type { ArchModel, Rect, Vec2, Vec3 } from '../../core/types.ts';
import {
  dist, pointInPolygon, polygonArea, polygonBounds, rectCenter, round,
} from '../../core/geometry.ts';
import {
  addFixture, emitAxis, emitBox, emitRun, warn, bump, info, barsOn, STORM_MAIN_Z, type PlumbState,
} from './state.ts';
import {
  manhattanLink, spineStation, spineTap, streetLateral, trunkSpine, TRUNK_WALL_INSET,
} from './routing.ts';

const AREA_PER_DRAIN = 400;
const MIN_DRAINS = 2;
const DOWNPIPE_D = 0.1;
const STORM_MAIN_D = 0.15;

export interface StormResult {
  roofDrains: Vec2[];
  downpipes: number;
}

/** Plumbing's corner of a shaft (see the convention above) */
export function plumbingShaftCorner(rect: Rect): Vec2 {
  return [rect.x + 0.15, rect.y + 0.15];
}

export function buildStorm(st: PlumbState): StormResult {
  const arch = st.ctx.arch as ArchModel;
  const roof = arch.roof;
  const out: StormResult = { roofDrains: [], downpipes: 0 };
  const above = st.buildingStoreys.filter(s => s.index >= 0);
  if (above.length === 0) return out;
  const topStorey = above[above.length - 1].id;
  const ground = st.groundStorey;
  const outline = roof?.outline && roof.outline.length > 2 ? roof.outline : null;
  if (!outline) {
    warn(st, 'noroof', 'architecture supplied no roof outline; storm drainage omitted');
    return out;
  }
  const bounds = polygonBounds(outline);
  const area = polygonArea(outline);

  // --- candidate downpipe positions ---------------------------------------
  const anchors: Vec2[] = [];
  for (const shaft of arch.shafts) {
    if (shaft.purpose === 'plumbing' || shaft.purpose === 'combined') anchors.push(plumbingShaftCorner(shaft.rect));
  }
  for (const core of arch.cores) {
    anchors.push([core.rect.x + 0.3, core.rect.y + 0.3]);
    anchors.push([core.rect.x + core.rect.w - 0.3, core.rect.y + core.rect.h - 0.3]);
  }

  // --- drain positions ----------------------------------------------------
  const positions: Vec2[] = [];
  if (roof.type === 'flat') {
    const target = Math.max(MIN_DRAINS, Math.ceil(area / AREA_PER_DRAIN));
    // low points next to the cores first (falls are laid to the core side)
    for (const core of arch.cores) {
      if (positions.length >= target) break;
      const c = rectCenter(core.rect);
      const p: Vec2 = [
        Math.min(bounds.x + bounds.w - 1.0, Math.max(bounds.x + 1.0, c[0])),
        Math.min(bounds.y + bounds.h - 1.0, Math.max(bounds.y + 1.0, c[1] + (core.rect.h / 2 + 1.2))),
      ];
      if (pointInPolygon(p, outline) && !positions.some(q => dist(p, q) < 3)) positions.push(p);
    }
    // then a coarse grid over the roof, skipping the plant / PV zones
    const nx = Math.max(1, Math.round(Math.sqrt(target * bounds.w / Math.max(1, bounds.h))));
    const ny = Math.max(1, Math.ceil(target / nx));
    for (let j = 0; j < ny && positions.length < target; j++) {
      for (let i = 0; i < nx && positions.length < target; i++) {
        const p: Vec2 = [
          bounds.x + bounds.w * (i + 0.5) / nx,
          bounds.y + bounds.h * (j + 0.5) / ny,
        ];
        if (!pointInPolygon(p, outline)) continue;
        if (roof.plantZone && inRect(roof.plantZone, p, 0.5)) continue;
        if (roof.pvZone && inRect(roof.pvZone, p, 0.5)) continue;
        if (positions.some(q => dist(p, q) < 3)) continue;
        positions.push(p);
      }
    }
    // guarantee the code minimum even on a tiny roof
    let guard = 0;
    while (positions.length < MIN_DRAINS && guard++ < 8) {
      const t = 0.25 + 0.5 * (positions.length % 2);
      const p: Vec2 = [bounds.x + bounds.w * t, bounds.y + bounds.h * (0.3 + 0.4 * (guard % 2))];
      if (pointInPolygon(p, outline) || guard > 4) positions.push(p);
    }
  }

  // --- roof drains ---------------------------------------------------------
  const perDrain = positions.length > 0 ? area / positions.length : 0;
  for (const p of positions) {
    addFixture(st, {
      type: 'roof-drain', storey: st.roofStorey, center: [p[0], p[1], 0],
      solid: true, patterns: ['PLB-06'],
      extraProps: [
        { name: 'CatchmentArea', value: round(perDrain, 1) },
        { name: 'OutletDiameter', value: DOWNPIPE_D },
        { name: 'DesignRainfall', value: '100 mm/h' },
      ],
    });
    out.roofDrains.push([round(p[0]), round(p[1])]);
    bump(st, 'roofDrains');
  }

  // --- downpipe positions --------------------------------------------------
  const downpipes: Vec2[] = [];
  const assign = (p: Vec2): Vec2 => {
    let best: Vec2 | null = null;
    let bd = Infinity;
    for (const a of anchors) {
      const d = dist(a, p);
      if (d < bd) { bd = d; best = a; }
    }
    return best && bd < 18 ? best : p;
  };
  if (roof.type === 'flat') {
    for (const p of positions) {
      const dp = assign(p);
      if (!downpipes.some(q => dist(q, dp) < 0.3)) downpipes.push(dp);
    }
  } else {
    // gutters + downpipes at the four corners of the bar, just outside the wall line
    for (const [sx, sy] of [[0, 0], [1, 0], [1, 1], [0, 1]] as Vec2[]) {
      downpipes.push([
        bounds.x + (sx === 0 ? -0.15 : bounds.w + 0.15),
        bounds.y + (sy === 0 ? -0.15 : bounds.h + 0.15),
      ]);
    }
    warn(st, 'gutter', `${roof.type} roof: eaves gutters are assumed (not modelled); ${downpipes.length} downpipes placed at the corners`);
  }

  // --- leaders on the top storey + vertical downpipes ----------------------
  const topF2f = info(st, topStorey).f2f;
  for (const p of positions) {
    const dp = downpipes.reduce((a, b) => (dist(b, p) < dist(a, p) ? b : a), downpipes[0]);
    if (!dp) continue;
    if (dist(dp, p) < 0.2) continue;
    emitRun(st, {
      storey: topStorey, system: 'storm', diameter: DOWNPIPE_D,
      // L-shaped leader under the roof slab: along X, then along Y to the downpipe
      path: manhattanLink([p[0], p[1], topF2f - 0.25], [dp[0], dp[1], topF2f - 0.25], 'x'),
      name: `Roof drain leader Ø${Math.round(DOWNPIPE_D * 1000)}`,
      patterns: ['PLB-06'],
    });
  }
  for (const dp of downpipes) {
    for (const s of above) {
      const f2f = info(st, s.id).f2f;
      emitAxis(st, {
        storey: s.id, system: 'storm', diameter: DOWNPIPE_D,
        a: [dp[0], dp[1], 0], b: [dp[0], dp[1], f2f],
        name: `Storm downpipe Ø${Math.round(DOWNPIPE_D * 1000)}`,
        patterns: ['PLB-06'],
        psetExtra: [{ name: 'Downpipe', value: true }],
      });
    }
    out.downpipes++;
    bump(st, 'downpipes');
  }

  // --- buried storm main out to the street ---------------------------------
  // The main runs along the bar (never diagonally between downpipes); every downpipe drops into
  // it through an L-shaped tap, and the connection leaves perpendicular to the street edge.
  if (downpipes.length > 0) {
    const spine = downpipes.length >= 2
      ? trunkSpine(barsOn(st, ground), downpipes, STORM_MAIN_Z, TRUNK_WALL_INSET)
      : null;
    const sorted = [...downpipes].sort((a, b) =>
      (spine ? spineStation(spine, a) - spineStation(spine, b) : 0) || a[0] - b[0] || a[1] - b[1]);
    for (const dp of sorted) {
      emitRun(st, {
        storey: ground, system: 'storm', diameter: DOWNPIPE_D,
        path: [[dp[0], dp[1], 0], [dp[0], dp[1], STORM_MAIN_Z]],
        name: 'Downpipe to buried storm main Ø100', patterns: ['PLB-06'],
      });
    }
    if (spine) {
      for (const path of spine.paths) {
        emitRun(st, {
          storey: ground, system: 'storm', diameter: STORM_MAIN_D, path,
          name: `Buried storm main Ø${Math.round(STORM_MAIN_D * 1000)}`, patterns: ['PLB-06'],
          psetExtra: [{ name: 'InvertZ', value: STORM_MAIN_Z }],
        });
      }
      for (const dp of sorted) {
        emitRun(st, {
          storey: ground, system: 'storm', diameter: DOWNPIPE_D,
          path: spineTap(spine, dp, STORM_MAIN_Z).slice().reverse(),
          name: `Downpipe tap to storm main Ø${Math.round(DOWNPIPE_D * 1000)}`, patterns: ['PLB-06'],
        });
      }
    }
    const exit = sorted.reduce((a, b) => (b[1] < a[1] ? b : a));
    const path: Vec3[] = spine
      ? streetLateral(spine, [exit[0], st.siteBounds.y], STORM_MAIN_Z, STORM_MAIN_Z, st.siteBounds.y)
      : [[exit[0], exit[1], STORM_MAIN_Z], [exit[0], st.siteBounds.y, STORM_MAIN_Z]];
    emitRun(st, {
      storey: ground, system: 'storm', diameter: STORM_MAIN_D, path,
      name: `Storm connection to the street Ø${Math.round(STORM_MAIN_D * 1000)}`,
      patterns: ['PLB-06'],
      psetExtra: [{ name: 'InvertZ', value: STORM_MAIN_Z }],
    });
  }

  st.apps.push({
    patternId: 'PLB-06',
    storey: st.roofStorey,
    params: {
      roofType: roof.type,
      roofArea: round(area, 1),
      drains: out.roofDrains.length,
      areaPerDrain: round(perDrain, 1),
      downpipes: out.downpipes,
      downpipeDiameter: DOWNPIPE_D,
      stormMainDiameter: STORM_MAIN_D,
    },
    note: roof.type === 'flat'
      ? 'drains at the low points of the falls, downpipes in core/shaft corners'
      : 'gutters at the eaves, downpipes at the corners',
  });
  return out;
}

function inRect(r: Rect, p: Vec2, pad = 0): boolean {
  return p[0] >= r.x - pad && p[0] <= r.x + r.w + pad && p[1] >= r.y - pad && p[1] <= r.y + r.h + pad;
}

/**
 * Optional fuel gas (kept deliberately minimal): a Ø20 riser in the plumbing corner of a shaft and
 * a meter bank on the street-facing wall. Only at detail 'high', in gas regions, with a
 * gas-capable DHW strategy.
 */
export function buildGas(st: PlumbState): boolean {
  const region = st.ctx.spec.region;
  const dhw = st.ctx.typology.dhw;
  const gasRegion = region === 'US' || region === 'UK' || region === 'AU' || region === 'CA';
  const gasDhw = dhw === 'per-unit-tank' || dhw === 'per-unit-tankless';
  if (st.detail !== 'high' || !gasRegion || !gasDhw) return false;
  const arch = st.ctx.arch as ArchModel;
  const shafts = arch.shafts.filter(s => s.purpose === 'plumbing' || s.purpose === 'combined');
  const above = st.buildingStoreys.filter(s => s.index >= 0);
  if (shafts.length === 0 || above.length === 0) {
    warn(st, 'nogas', 'no plumbing/combined shaft available for a gas riser; gas omitted');
    return false;
  }
  const shaft = shafts[0];
  const xy: Vec2 = [shaft.rect.x + 0.15, shaft.rect.y + shaft.rect.h - 0.15];
  for (const s of above) {
    if (!shaft.storeys.includes(s.id)) continue;
    emitAxis(st, {
      storey: s.id, system: 'gas', diameter: 0.02,
      a: [xy[0], xy[1], 0], b: [xy[0], xy[1], info(st, s.id).f2f],
      name: 'Gas riser Ø20', patterns: ['PLB-07'],
      psetExtra: [{ name: 'ShaftId', value: shaft.id }, { name: 'Service', value: 'natural gas' }],
    });
  }
  const ground = st.groundStorey;
  const front = arch.walls
    .filter(w => w.storey === ground && w.isExternal)
    .sort((a, b) => (a.start[1] + a.end[1]) / 2 - (b.start[1] + b.end[1]) / 2)[0];
  if (front) {
    const mx = (front.start[0] + front.end[0]) / 2 + 1.5;
    const my = (front.start[1] + front.end[1]) / 2 - front.thickness / 2 - 0.2;
    emitBox(st, {
      storey: ground,
      ifcType: 'IfcFlowMeter',
      predefinedType: 'GASMETER',
      name: 'Gas meter bank',
      objectType: 'Gas meter bank',
      center: [mx, my, 0.4],
      width: 1.2, depth: 0.3, height: 1.0,
      system: 'gas',
      kind: 'METER',
      psets: [{
        name: 'Forma_Plumbing',
        properties: [
          { name: 'System', value: 'Fuel gas' },
          { name: 'Dwellings', value: arch.units.length },
          { name: 'RiserDiameter', value: 0.02 },
        ],
      }],
      patterns: ['PLB-07'],
    });
  }
  warn(st, 'gas', 'fuel gas is modelled minimally: one Ø20 riser in the plumbing shaft corner and a meter bank at the street wall (no per-dwelling gas branches)');
  bump(st, 'gasRisers');
  return true;
}
