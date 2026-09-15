/**
 * Minimal inlined ifc-lite embed client (adapted from @ifc-lite/embed-sdk, MPL-2.0).
 * Creates an iframe against https://embed.ifclite.com, performs the
 * READY → INIT → INIT_ACK handshake and exposes the commands this app needs.
 *
 * The only network access in the whole artifact lives here; every failure path
 * degrades to the offline axonometric view.
 */

const EMBED_SOURCE = 'ifc-lite-embed';
const PROTOCOL_VERSION = '1.0';
export const DEFAULT_EMBED_ORIGIN = 'https://embed.ifclite.com';

export interface ModelStats { entities: number; triangles: number; vertices: number }

interface Envelope {
  source: typeof EMBED_SOURCE;
  version: typeof PROTOCOL_VERSION;
  type: string;
  requestId?: string;
  responseId?: string;
  data?: unknown;
  error?: { code: string; message: string };
}

export interface EmbedInit {
  container: HTMLElement;
  theme?: 'light' | 'dark';
  origin?: string;
  timeoutMs?: number;
  hideTypes?: string[];
}

export class IfcLiteEmbed {
  readonly ready: Promise<void>;
  private iframe: HTMLIFrameElement;
  private origin: string;
  private expected: string;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }>();
  private listeners = new Map<string, Set<(d: unknown) => void>>();
  private dead = false;

  constructor(opts: EmbedInit) {
    this.origin = opts.origin ?? DEFAULT_EMBED_ORIGIN;
    this.expected = new URL(this.origin).origin;
    const p = new URLSearchParams();
    p.set('autoLoad', 'false');
    if (opts.theme) p.set('theme', opts.theme);
    if (opts.hideTypes?.length) p.set('hideTypes', opts.hideTypes.join(','));
    this.iframe = document.createElement('iframe');
    this.iframe.src = `${this.origin}/v1?${p.toString()}`;
    this.iframe.style.cssText = 'width:100%;height:100%;border:none;display:block';
    this.iframe.setAttribute('allow', 'cross-origin-isolated');
    this.iframe.setAttribute('loading', 'eager');
    this.iframe.setAttribute('title', 'ifc-lite 3D viewer');
    opts.container.appendChild(this.iframe);
    window.addEventListener('message', this.onMessage);

    const timeout = opts.timeoutMs ?? 12000;
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(
        () => reject(new Error(`Viewer handshake timed out after ${timeout} ms`)), timeout,
      );
      this.internal.set('READY', () => this.send({ type: 'INIT', data: {} }));
      this.internal.set('INIT_ACK', () => { clearTimeout(timer); resolve(); });
    });
  }

  private internal = new Map<string, (msg: Envelope) => void>();

  /** Parsing a million-entity file can take a couple of minutes on a slow machine. */
  loadModelBuffer(buffer: ArrayBuffer): Promise<ModelStats> {
    return this.request('LOAD_MODEL_BUFFER', buffer, [buffer], 180000) as Promise<ModelStats>;
  }
  fitToView(ids?: number[]): Promise<void> { return this.request('FIT_TO_VIEW', { ids }) as Promise<void>; }
  isolate(ids: number[]): Promise<void> { return this.request('ISOLATE', { ids }) as Promise<void>; }
  hide(ids: number[]): Promise<void> { return this.request('HIDE', { ids }) as Promise<void>; }
  showAll(): Promise<void> { return this.request('SHOW_ALL') as Promise<void>; }
  select(ids: number[]): Promise<void> { return this.request('SELECT', { ids }) as Promise<void>; }
  selectByGuid(guids: string[]): Promise<{ resolved: number[] }> {
    return this.request('SELECT_BY_GUID', { guids }) as Promise<{ resolved: number[] }>;
  }
  setColors(colorMap: Record<number, [number, number, number, number]>): Promise<void> {
    const stringKeyed: Record<string, [number, number, number, number]> = {};
    for (const [k, v] of Object.entries(colorMap)) stringKeyed[k] = v;
    return this.request('SET_COLORS', { colorMap: stringKeyed }) as Promise<void>;
  }
  resetColors(): Promise<void> { return this.request('RESET_COLORS') as Promise<void>; }
  setTheme(theme: 'light' | 'dark'): Promise<void> { return this.request('SET_THEME', { theme }) as Promise<void>; }
  setView(preset: 'top' | 'front' | 'left' | 'right' | 'back' | 'bottom'): Promise<void> {
    return this.request('SET_VIEW', { preset }) as Promise<void>;
  }

  on(event: string, cb: (data: unknown) => void): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(cb);
    this.listeners.set(event, set);
    return () => this.listeners.get(event)?.delete(cb);
  }

  destroy(): void {
    this.dead = true;
    window.removeEventListener('message', this.onMessage);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Viewer destroyed')); }
    this.pending.clear();
    this.listeners.clear();
    this.iframe.remove();
  }

  private onMessage = (ev: MessageEvent): void => {
    if (ev.origin !== this.expected) return;
    if (ev.source !== this.iframe.contentWindow) return;
    const msg = ev.data as Envelope | null;
    if (!msg || typeof msg !== 'object' || msg.source !== EMBED_SOURCE || typeof msg.type !== 'string') return;
    if (msg.responseId && this.pending.has(msg.responseId)) {
      const req = this.pending.get(msg.responseId)!;
      clearTimeout(req.timer);
      this.pending.delete(msg.responseId);
      if (msg.error) req.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      else req.resolve(msg.data);
      return;
    }
    const kebab = msg.type.toLowerCase().replace(/_/g, '-');
    this.listeners.get(kebab)?.forEach((fn) => { try { fn(msg.data); } catch (e) { console.error(e); } });
    this.internal.get(msg.type)?.(msg);
  };

  private send(msg: Partial<Envelope>, transfer?: Transferable[]): void {
    if (this.dead) return;
    this.iframe.contentWindow?.postMessage(
      { source: EMBED_SOURCE, version: PROTOCOL_VERSION, ...msg }, this.origin, transfer ?? [],
    );
  }

  private request(type: string, data?: unknown, transfer?: Transferable[], timeoutMs = 30000): Promise<unknown> {
    if (this.dead) return Promise.reject(new Error('Viewer destroyed'));
    const requestId = `${type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${type} timed out after ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.send({ type, requestId, data }, transfer);
    });
  }
}

/**
 * expressId → IFC GlobalId, parsed straight out of the STEP text
 * (`#42=IFCWALL('1hqU2Ff...',#5,…)`). Used to talk to the viewer by GUID when the
 * writer's idMap and the viewer's entity ids ever disagree.
 */
export function parseIdGuidMap(step: string): Map<number, string> {
  const out = new Map<number, string>();
  const re = /#(\d+)\s*=\s*([A-Za-z][A-Za-z0-9_]*)\s*\(\s*'([^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(step)) !== null) {
    const id = Number(m[1]);
    const type = m[2];
    const guid = m[3];
    if (!/^ifc/i.test(type)) continue;
    if (guid.length !== 22) continue;
    out.set(id, guid);
  }
  return out;
}

/** True when the app is running from a file:// URL, where the iframe cannot load. */
export function isFileProtocol(): boolean {
  try { return location.protocol === 'file:'; } catch { return false; }
}
