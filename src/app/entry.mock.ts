/** Bundle entry for `build.mjs --mock`: registers only the mock backend. */
import { registerBackend } from './backend.ts';
import { MOCK_BACKEND } from './mock-generate.ts';
import { boot } from './main.ts';

registerBackend(MOCK_BACKEND);
boot();
