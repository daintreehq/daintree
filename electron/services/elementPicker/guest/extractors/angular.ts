/// <reference lib="dom" />
/**
 * The Angular extractor asset: built by `scripts/build-main.mjs` and installed
 * into a document's main world once a detection names Angular.
 */

import { installExtractor, type ExtractorHostApi } from "../registry.js";
import { createAngularExtractor } from "./angularExtractor.js";

declare const api: ExtractorHostApi;

installExtractor(api, createAngularExtractor());
