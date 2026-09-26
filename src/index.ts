/**
 * Package entry point for opencode-smart-voice-notify.
 *
 * Exposes a dual V1 + V2 plugin, mirroring the shape used by other plugins in
 * the ecosystem:
 *
 *   - OpenCode V2 (>= 2.0.x) reads the `id` / `setup` fields produced by
 *     `Plugin.define` and calls `setup(ctx)`.
 *   - OpenCode V1 (1.18.29+) reads the legacy `server` field.
 *
 * The V1 implementation is exported unchanged as the `server` field (and as the
 * named `SmartVoiceNotifyPlugin` export) so existing consumers and tests keep
 * working, while the V2 adapter lives in `./v2.ts`.
 */

import { Plugin } from '@opencode/plugin';

import { SmartVoiceNotifyPlugin } from './plugin.js';
import { smartVoiceNotifyV2 } from './v2.js';

const v2 = Plugin.define(smartVoiceNotifyV2);

/**
 * Combined plugin export.  The object literal is written explicitly (rather than
 * exporting the `Plugin.define` result directly) so the emitted declaration is
 * stable and clearly includes `id`, `setup`, and `server`.
 */
export default {
  id: v2.id,
  setup: v2.setup,
  server: SmartVoiceNotifyPlugin,
};

// Named export retained for V1 consumers (and existing tests) that import the
// legacy hook function directly.
export { SmartVoiceNotifyPlugin };

// Re-export the V2 building blocks for consumers that need them.
export {
  smartVoiceNotifyV2,
  PLUGIN_ID,
  translateV2Event,
  createShellRunner,
  createClientShim,
  isDuplicateEvent,
  rememberSessionLocation,
  getSessionLocation,
} from './v2.js';
