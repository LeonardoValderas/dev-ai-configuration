import { createInstaller } from '../../shared/apply.mjs';
import { MANIFEST_PATH, verifyWithinCanonical, generate } from './generate.mjs';
let allowedPaths;
const accepts = (p) => { allowedPaths ??= new Set(generate({ context7: true }).files.keys()); return allowedPaths.has(p); };
export const { apply, uninstall, planActions, resolveTarget, readManifest } = createInstaller({
  adapter: 'cursor', manifestPath: MANIFEST_PATH, verify: verifyWithinCanonical,
  accepts,
});
