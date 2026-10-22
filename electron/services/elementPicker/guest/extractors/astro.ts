/// <reference lib="dom" />
/**
 * The Astro extractor asset. Not in the shipped catalog yet: #13888 lists it
 * with the other wave-three frameworks, and until then only tests build it.
 */

import { astroExtractor } from "../astroExtractor.js";
import { installExtractor, type ExtractorHostApi } from "../registry.js";

declare const api: ExtractorHostApi;

installExtractor(api, astroExtractor);
