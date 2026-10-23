/// <reference lib="dom" />
/**
 * The Preact extractor asset: built by `scripts/build-main.mjs` and installed
 * into a document's main world once a detection names Preact. The reading
 * itself lives in `../preact/`, where tests drive it directly.
 */

import { installExtractor, type ExtractorHostApi } from "../registry.js";
import { createPreactExtractor } from "../preact/extractor.js";

declare const api: ExtractorHostApi;

installExtractor(api, createPreactExtractor());
