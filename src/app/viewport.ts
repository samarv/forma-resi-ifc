/**
 * Pan/zoom SVG viewport shared by the Plans, Site and Axon views.
 *
 * Camera: screen = drawing * k + t, where drawing = (worldX, -worldY).
 * Only the camera group's `transform` changes while panning/zooming, plus the
 * small screen-space overlay (scale bar + north arrow), so dragging stays smooth.
 */
import type { Compass, Rect } from '../core/types.ts';
import type { DisplayUnits } from '../core/units.ts';
import { M_TO_FT } from '../core/units.ts';
import type { Drawing, Hit } from './plan-svg.ts';
import { pickHit } from './plan-svg.ts';
import { esc } from './util.ts';

const COMPASS_ORDER: Compass[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** Screen rotation (deg, clockwise) for an arrow that should point at true north. */
export function northScreenDeg(streetFacing: Compass): number {
  const i = COMPASS_ORDER.indexOf(streetFacing);
  if (i < 0) return 0;
  const plusYBearing = ((i + 4) % 8) * 45; // +Y points away from the street
  return plusYBearing === 0 ? 0 : -plusYBearing;
}

/** Nice round scale-bar length: 1 / 2 / 5 × 10ⁿ in display units. */
export function niceScaleLength(target: number): number {
  if (!(target > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(target));
  const n = target / p;
  return (n >= 5 ? 5 : n >= 2 ? 2 : 1) * p;
}

export interface ViewportHooks {
  units: () => DisplayUnits;
  streetFacing: () => Compass;
  onPick?: (hit: Hit | null) => void;
  showOverlay?: boolean;
}

export class Viewport {
  private host: HTMLElement;
  private svg: SVGSVGElement;
  private cam: SVGGElement;
  private ov: SVGGElement;
  private tip: HTMLDivElement;
  private hooks: ViewportHooks;
  private drawing: Drawing | null = null;
  private k = 10;
  private tx = 0;
  private ty = 0;
  private dragging = false;
  private moved = false;
  private last: [number, number] = [0, 0];
  private ovRaf = 0;
  /** true until a fit has happened at a real (visible) size */
  private needsFit = true;

  constructor(host: HTMLElement, hooks: ViewportHooks) {
    this.host = host;
    this.hooks = hooks;
    host.classList.add('viewport');
    host.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg"><g class="defs"></g><g class="cam"></g><g class="ov"></g></svg><div class="dwg-tip" hidden></div>`;
    this.svg = host.querySelector('svg')!;
    this.cam = host.querySelector('g.cam')!;
    this.ov = host.querySelector('g.ov')!;
    this.tip = host.querySelector('div.dwg-tip')!;
    this.bind();
    // The panel can be laid out at zero size (hidden tab, hidden pane) when the
    // first drawing arrives; fit as soon as it has a real size.
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        if (!this.drawing) return;
        if (this.needsFit) this.fit();
        else this.apply();
      });
      ro.observe(host);
    }
  }

  setDrawing(d: Drawing, refit: boolean): void {
    this.drawing = d;
    (this.host.querySelector('g.defs') as SVGGElement).innerHTML = d.defs;
    this.cam.innerHTML = d.body;
    if (refit || this.needsFit || !Number.isFinite(this.k)) this.fit();
    else this.apply();
  }

  clear(): void {
    this.drawing = null;
    this.cam.innerHTML = '';
    this.ov.innerHTML = '';
  }

  size(): [number, number] {
    const r = this.host.getBoundingClientRect();
    return [Math.max(r.width, 1), Math.max(r.height, 1)];
  }

  fit(): void {
    const d = this.drawing;
    const [w, h] = this.size();
    if (!d) return;
    if (w < 24 || h < 24) {
      // The panel is hidden (display:none) — keep the camera and fit when it shows.
      this.needsFit = true;
      return;
    }
    this.needsFit = false;
    const b = d.bounds;
    const pad = 1.06;
    this.k = Math.min(w / (b.w * pad), h / (b.h * pad));
    if (!Number.isFinite(this.k) || this.k <= 0) this.k = 10;
    // drawing-space centre: x centre = b.x + b.w/2, y centre = -(b.y + b.h/2)
    const cx = b.x + b.w / 2;
    const cy = -(b.y + b.h / 2);
    this.tx = w / 2 - cx * this.k;
    this.ty = h / 2 - cy * this.k;
    this.apply();
  }

  zoomBy(f: number, px: number, py: number): void {
    const k2 = Math.min(4000, Math.max(0.4, this.k * f));
    this.tx = px - (px - this.tx) * (k2 / this.k);
    this.ty = py - (py - this.ty) * (k2 / this.k);
    this.k = k2;
    this.apply();
  }

  private apply(): void {
    this.cam.setAttribute('transform', `translate(${this.tx.toFixed(2)} ${this.ty.toFixed(2)}) scale(${this.k.toFixed(5)})`);
    if (this.hooks.showOverlay === false) return;
    if (this.ovRaf) return;
    this.ovRaf = requestAnimationFrame(() => { this.ovRaf = 0; this.overlay(); });
  }

  /** Screen px → world metres */
  toWorld(px: number, py: number): [number, number] {
    return [(px - this.tx) / this.k, -((py - this.ty) / this.k)];
  }

  private overlay(): void {
    const [w, h] = this.size();
    const units = this.hooks.units();
    const imperial = units === 'imperial';
    const targetPx = 120;
    const inDisp = (m: number) => (imperial ? m * M_TO_FT : m);
    const len = niceScaleLength(inDisp(targetPx / this.k));
    const px = (imperial ? len / M_TO_FT : len) * this.k;
    const x0 = 14, y0 = h - 20;
    const nd = northScreenDeg(this.hooks.streetFacing());
    this.ov.innerHTML = `
<g font-family="inherit">
  <line x1="${x0}" y1="${y0}" x2="${x0 + px}" y2="${y0}" stroke="var(--ink-2)" stroke-width="1.5"/>
  <line x1="${x0}" y1="${y0 - 4}" x2="${x0}" y2="${y0 + 4}" stroke="var(--ink-2)" stroke-width="1.5"/>
  <line x1="${x0 + px}" y1="${y0 - 4}" x2="${x0 + px}" y2="${y0 + 4}" stroke="var(--ink-2)" stroke-width="1.5"/>
  <text x="${x0 + px / 2}" y="${y0 - 7}" font-size="10.5" fill="var(--ink-2)" text-anchor="middle">${len}${imperial ? ' ft' : ' m'}</text>
  <text x="${x0}" y="${y0 + 15}" font-size="10" fill="var(--ink-3)">1 : ${Math.round(3779.5 / this.k)} on screen</text>
</g>
<g transform="translate(${w - 34} 34)">
  <circle r="17" fill="var(--surface)" fill-opacity="0.72" stroke="var(--rule-2)" stroke-width="1"/>
  <g transform="rotate(${nd})">
    <path d="M0 -12L4 6L0 2.5L-4 6Z" fill="var(--ink-2)"/>
    <text x="0" y="-13.5" font-size="8.5" fill="var(--ink-3)" text-anchor="middle">N</text>
  </g>
</g>
<text x="${w - 12}" y="${h - 10}" font-size="9.5" fill="var(--ink-3)" text-anchor="end">street at bottom (−Y)</text>`;
  }

  private bind(): void {
    const host = this.host;
    host.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const r = host.getBoundingClientRect();
      const f = Math.exp(-ev.deltaY * (ev.deltaMode === 1 ? 0.05 : 0.0016));
      this.zoomBy(f, ev.clientX - r.left, ev.clientY - r.top);
    }, { passive: false });

    host.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      this.dragging = true;
      this.moved = false;
      this.last = [ev.clientX, ev.clientY];
      host.classList.add('is-panning');
      host.setPointerCapture(ev.pointerId);
    });
    host.addEventListener('pointermove', (ev) => {
      const r = host.getBoundingClientRect();
      if (this.dragging) {
        const dx = ev.clientX - this.last[0], dy = ev.clientY - this.last[1];
        if (Math.abs(dx) + Math.abs(dy) > 2) this.moved = true;
        this.tx += dx;
        this.ty += dy;
        this.last = [ev.clientX, ev.clientY];
        this.apply();
        this.hideTip();
        return;
      }
      this.hover(ev.clientX - r.left, ev.clientY - r.top);
    });
    const end = (ev: PointerEvent) => {
      if (!this.dragging) return;
      this.dragging = false;
      host.classList.remove('is-panning');
      try { host.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
    };
    host.addEventListener('pointerup', (ev) => {
      const wasMove = this.moved;
      end(ev);
      if (!wasMove && this.hooks.onPick) {
        const r = host.getBoundingClientRect();
        const [wx, wy] = this.toWorld(ev.clientX - r.left, ev.clientY - r.top);
        this.hooks.onPick(this.drawing ? pickHit(this.drawing.hits, wx, wy, 0.2 / this.k * 10) : null);
      }
    });
    host.addEventListener('pointercancel', end);
    host.addEventListener('pointerleave', () => this.hideTip());
    host.addEventListener('dblclick', () => this.fit());
    window.addEventListener('resize', () => this.apply());
  }

  private hover(px: number, py: number): void {
    const d = this.drawing;
    if (!d) return;
    const [wx, wy] = this.toWorld(px, py);
    const hit = pickHit(d.hits, wx, wy, 6 / this.k);
    if (!hit) { this.hideTip(); return; }
    const [w, h] = this.size();
    this.tip.innerHTML = `<b>${esc(hit.label)}</b><br><span class="mono">${esc(hit.id)}</span>
      <dl>${hit.meta.slice(0, 7).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
    this.tip.hidden = false;
    const tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
    this.tip.style.left = `${Math.min(Math.max(px + 12, 4), Math.max(w - tw - 4, 4))}px`;
    this.tip.style.top = `${Math.min(Math.max(py + 12, 4), Math.max(h - th - 4, 4))}px`;
  }

  private hideTip(): void {
    if (!this.tip.hidden) this.tip.hidden = true;
  }

  /** Centre the camera on a world rect without changing zoom (used by "Find"). */
  centerOn(r: Rect): void {
    const [w, h] = this.size();
    const cx = r.x + r.w / 2;
    const cy = -(r.y + r.h / 2);
    this.tx = w / 2 - cx * this.k;
    this.ty = h / 2 - cy * this.k;
    this.apply();
  }
}
