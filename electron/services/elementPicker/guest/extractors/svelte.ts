/// <reference lib="dom" />
/**
 * Placeholder Svelte extractor: proves the detection-gated loading path end to
 * end and contributes nothing. #13873 replaces its body with the Svelte
 * extraction the plugin runtime does today.
 */

import { installExtractor, type ExtractorHostApi } from "../registry.js";

declare const api: ExtractorHostApi;

installExtractor(api, { extract: () => null });
