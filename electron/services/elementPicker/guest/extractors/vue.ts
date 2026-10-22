/// <reference lib="dom" />
/**
 * The Vue extractor asset, for a document's main world once a detection names
 * Vue. Built like the shipped extractors; #13888 adds it to the core catalog
 * alongside the other frameworks of its wave, so until then only tests build it.
 */

import { installExtractor, type ExtractorHostApi } from "../registry.js";
import { createVueExtractor } from "./vueExtractor.js";

declare const api: ExtractorHostApi;

installExtractor(api, createVueExtractor());
