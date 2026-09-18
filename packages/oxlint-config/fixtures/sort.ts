// Fixture for simple-import-sort/imports (npm plugin via jsPlugins shim).
// EXPECTED: exactly one diagnostic (imports out of order).
import { two } from './z-module.js';
import { one } from './a-module.js';

export const use = [one, two];
