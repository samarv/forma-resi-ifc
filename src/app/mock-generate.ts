/**
 * Mock backend: satisfies the same surface as the real generator
 * (generateBuilding / writeIfc / METRICS / UNIT_TEMPLATES) using src/app/mock-model.ts.
 */
import type { Backend } from './backend.ts';
import type { BuildingSpec, DesignModel } from '../core/types.ts';
import type { PartialSpec } from '../core/spec.ts';
import { buildMockModel, mockWriteIfc, MOCK_METRICS, MOCK_TEMPLATES } from './mock-model.ts';

export function generateBuilding(spec: PartialSpec | BuildingSpec): DesignModel {
  return buildMockModel(spec as PartialSpec);
}

export const MOCK_BACKEND: Backend = {
  kind: 'mock',
  generateBuilding,
  writeIfc: mockWriteIfc,
  metrics: MOCK_METRICS,
  templates: MOCK_TEMPLATES,
};
