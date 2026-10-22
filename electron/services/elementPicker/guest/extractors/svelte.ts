/// <reference lib="dom" />
/**
 * The Svelte extractor asset: built by `scripts/build-main.mjs` and evaluated
 * into the page's main world once something says the page uses Svelte. The
 * reading itself lives in `../svelte/`, where tests drive it directly.
 */

import { installExtractor, type ExtractorHostApi } from "../registry.js";
import { createSvelteExtractor } from "../svelte/extractor.js";

declare const api: ExtractorHostApi;

installExtractor(api, createSvelteExtractor());
