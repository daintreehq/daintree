/// <reference lib="dom" />
/**
 * The React extractor asset: built by `scripts/build-main.mjs` and installed
 * into a document's main world once a detection names React.
 */

import { installExtractor, type ExtractorHostApi } from "../registry.js";
import { createReactExtractor } from "./reactExtractor.js";

declare const api: ExtractorHostApi;

installExtractor(api, createReactExtractor());
