/**
 * Bundle entry for the real generator. Registers the real backend plus the mock one,
 * so a production build still supports `?mock=1` for UI debugging.
 */
import type { DesignModel, IfcOutput } from '../core/types.ts';
import { registerBackend, asArray, type Backend } from './backend.ts';
import { MOCK_BACKEND } from './mock-generate.ts';
import { boot } from './main.ts';

import { generateBuilding } from '../pipeline.ts';
import { writeIfc } from '../ifc/writer.ts';
import { METRICS } from '../core/metrics.ts';
import { UNIT_TEMPLATES } from '../disciplines/architecture/templates.ts';
import { setArchitectureDeps } from '../disciplines/architecture/index.ts';
import { layoutUnit } from '../disciplines/architecture/unit-layout.ts';

// The architecture module resolves its unit templates / layout function lazily via
// `await resolveArchitectureDeps()`. A single-file bundle cannot await a dynamic
// import before the first synchronous generate, so inject them statically instead.
setArchitectureDeps({ templates: UNIT_TEMPLATES, layoutUnit });

/** The writer may take (model) or (model, options); pass both and let it ignore the extra. */
type WriterFn = (model: DesignModel, options?: unknown) => IfcOutput;

const REAL_BACKEND: Backend = {
  kind: 'real',
  generateBuilding,
  writeIfc: (model) => (writeIfc as unknown as WriterFn)(model, {
    schema: model.spec.options?.ifcSchema,
    author: 'forma-resi-ifc web app',
  }),
  metrics: asArray(METRICS as never),
  templates: asArray(UNIT_TEMPLATES as never),
};

registerBackend(REAL_BACKEND);
registerBackend(MOCK_BACKEND);
boot();
