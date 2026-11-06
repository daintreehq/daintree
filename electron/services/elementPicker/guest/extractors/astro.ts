/// <reference lib="dom" />
/**
 * The Astro extractor asset: built by `scripts/build-main.mjs` and installed
 * into a document's main world once a detection names Astro.
 */

import { createAstroExtractor } from "../astroExtractor.js";
import { installExtractor, type ExtractorHostApi } from "../registry.js";

declare const api: ExtractorHostApi;

installExtractor(api, createAstroExtractor(api.served));
