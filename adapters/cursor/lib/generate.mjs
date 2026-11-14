import { generatePortable, verifyPortable } from '../../shared/portable.mjs';
export { AdapterError } from '../../shared/portable.mjs';
export const MANIFEST_PATH = '.cursor/dac-manifest.json';
export const generate = (options) => generatePortable('cursor', options);
export const verifyWithinCanonical = (plan) => verifyPortable('cursor', plan);
