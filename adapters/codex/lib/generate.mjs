import { generatePortable, verifyPortable } from '../../shared/portable.mjs';
export { AdapterError } from '../../shared/portable.mjs';
export const MANIFEST_PATH = '.codex/dac-manifest.json';
export const generate = (options) => generatePortable('codex', options);
export const verifyWithinCanonical = (plan) => verifyPortable('codex', plan);
