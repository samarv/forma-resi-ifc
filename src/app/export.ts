/** Downloads, clipboard and spec-file loading. */
import type { DesignModel, IfcOutput } from '../core/types.ts';

export function safeFileName(name: string): string {
  const s = String(name ?? '').trim().replace(/[^A-Za-z0-9 _.-]+/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-');
  return (s.replace(/^-|-$/g, '') || 'building').slice(0, 80);
}

export function downloadText(filename: string, mime: string, text: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export interface Report {
  generatedAt: string;
  backend: string;
  spec: DesignModel['spec'];
  typology: { id: string; name: string; access: string };
  storeys: { id: string; name: string; index: number; elevation: number; height: number; use: string }[];
  metrics: DesignModel['metrics'];
  patterns: { registered: number; applied: number; applications: number; byPattern: Record<string, number> };
  elements: { total: number; byDiscipline: Record<string, number>; byIfcType: Record<string, number> };
  ifc: { entityCount: number; fileSize: number; schema: string } | null;
  warnings: string[];
  timings: Record<string, number>;
}

export function buildReport(model: DesignModel, ifc: IfcOutput | null, backend: string): Report {
  const byDiscipline: Record<string, number> = {};
  const byIfcType: Record<string, number> = {};
  for (const e of model.elements) {
    byDiscipline[e.discipline] = (byDiscipline[e.discipline] ?? 0) + 1;
    byIfcType[e.ifcType] = (byIfcType[e.ifcType] ?? 0) + 1;
  }
  const byPattern: Record<string, number> = {};
  for (const a of model.patterns?.applications ?? []) {
    byPattern[a.patternId] = (byPattern[a.patternId] ?? 0) + 1;
  }
  return {
    generatedAt: new Date().toISOString(),
    backend,
    spec: model.spec,
    typology: { id: model.typology.id, name: model.typology.name, access: model.typology.access },
    storeys: model.storeys.map((s) => ({ id: s.id, name: s.name, index: s.index, elevation: s.elevation, height: s.height, use: String(s.use) })),
    metrics: model.metrics,
    patterns: {
      registered: model.patterns?.book?.length ?? 0,
      applied: Object.keys(byPattern).length,
      applications: model.patterns?.applications?.length ?? 0,
      byPattern,
    },
    elements: { total: model.elements.length, byDiscipline, byIfcType },
    ifc: ifc ? { entityCount: ifc.entityCount, fileSize: ifc.fileSize, schema: model.spec.options.ifcSchema } : null,
    warnings: model.warnings ?? [],
    timings: model.timings ?? {},
  };
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context; fall back to a hidden textarea.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;left:-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function readJsonFile(file: File): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('Could not read the file'));
    fr.onload = () => {
      try {
        resolve(JSON.parse(String(fr.result)));
      } catch (err) {
        reject(new Error(`Not valid JSON: ${String(err)}`));
      }
    };
    fr.readAsText(file);
  });
}

/** Accepts a bare PartialSpec or a report produced by buildReport. */
export function specFromLoaded(data: unknown): unknown {
  if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>;
    if (o.spec && typeof o.spec === 'object') return o.spec;
    if (o.typology) return o;
  }
  throw new Error('No spec found in the file (expected a spec object with a `typology`, or a report with a `spec` key)');
}
