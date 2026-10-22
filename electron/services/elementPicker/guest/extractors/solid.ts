/// <reference lib="dom" />
/**
 * Solid's extractor. Solid's stock dev build erases component boundaries, so
 * the only thing to read is what solid-devtools' locator stamps on elements
 * when the user installed it; on every other Solid page this contributes
 * nothing, and the picker reports names, chain and source as not exposed. It
 * never reaches into the page's runtime: `SolidDevtools$$` is the debugger's
 * API, not data.
 */

import { installExtractor, type ExtractorHostApi } from "../registry.js";
import { solidContribution } from "./solidLocator.js";

declare const api: ExtractorHostApi;

installExtractor(api, { extract: (element) => solidContribution(element) });
