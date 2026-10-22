/// <reference lib="dom" />
/**
 * The Preact extractor asset. Not in the shipped catalog yet: #13888 lists it
 * with the other wave-three frameworks, and until then only tests build it.
 * The reading itself lives in `../preact/`, where tests drive it directly.
 */

import { installExtractor, type ExtractorHostApi } from "../registry.js";
import { createPreactExtractor } from "../preact/extractor.js";

declare const api: ExtractorHostApi;

installExtractor(api, createPreactExtractor());
