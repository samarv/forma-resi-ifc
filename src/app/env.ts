/** Build-time constants injected by scripts/build.mjs via esbuild --define. */
declare const __BACKEND_MODE__: string;
declare const __BUILD_ID__: string;

export const BUILD_BACKEND: string = typeof __BACKEND_MODE__ === 'string' ? __BACKEND_MODE__ : 'dev';
export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';
