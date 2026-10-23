/// <reference lib="dom" />
/**
 * The Vue extractor asset: built by `scripts/build-main.mjs` and installed
 * into a document's main world once a detection names Vue.
 */

import { installExtractor, type ExtractorHostApi } from "../registry.js";
import { createVueExtractor } from "./vueExtractor.js";

declare const api: ExtractorHostApi;

installExtractor(api, createVueExtractor());
