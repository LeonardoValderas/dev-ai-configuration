// Shared transactional installer, retaining the Claude Code adapter API.
import { createInstaller } from '../../shared/apply.mjs';
import { MANIFEST_PATH } from './generate.mjs';
export const { apply, uninstall, planActions, resolveTarget, readManifest } = createInstaller({ adapter: 'claude-code', manifestPath: MANIFEST_PATH });
