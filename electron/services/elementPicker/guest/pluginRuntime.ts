/// <reference lib="dom" />
/**
 * The registration half of an extractor asset, for a plugin's guest entry to
 * use. A core extractor bundles `installExtractor` itself and calls it; a
 * plugin's entry is a standalone script that cannot, so the host evaluates this
 * ahead of it and the entry's extractor is registered through `api.register`.
 */

import {
  installExtractor,
  type ElementPickerExtractor,
  type ExtractorHostApi,
} from "./registry.js";

declare const api: ExtractorHostApi & { register?: (extractor: ElementPickerExtractor) => void };

api.register = (extractor) => installExtractor(api, extractor);
