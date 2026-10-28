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

// Selection only: the locator is a string to parse, and hover parses nothing.
// Declared, so a hover's silence is not taken for finding nothing.
installExtractor(api, {
  selectionOnly: true,
  extract: (element, phase) => (phase === "selection" ? solidContribution(element) : null),
});
