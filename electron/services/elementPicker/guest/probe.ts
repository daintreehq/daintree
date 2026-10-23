/// <reference lib="dom" />
/**
 * The main-world half of detection, run as a one-shot evaluate rather than
 * left in the page: globals and node expandos are only visible from the page's
 * own world, and a page with no framework should keep nothing of ours there.
 *
 * The host wraps this asset in a prelude (`guestSources.ts`) that has already
 * proved, by handshake, that the document holds this install's bootstrap, and
 * that returns `api.result` by value. The host validates that value against
 * the wire schema; nothing here is trusted because it ran in the page's world.
 */

import type { FrameworkDetection } from "../../../../shared/elementPicker/observation.js";
import { DETECTION_LIMITS, DetectionSet, detectGlobals, sampleDocument } from "./detectors.js";
import { detectProviders, type ProviderProbe } from "./providerDetection.js";

declare const api: { result: FrameworkDetection[] | null; providers: ProviderProbe[] };

const detections = new DetectionSet();
detectGlobals(globalThis, detections);
sampleDocument(document, detections, { expandos: true });
const found = detections.toArray();
// Core detections first: a page that saturates the wire limit keeps what it always did.
api.result = found.concat(
  detectProviders(api.providers, globalThis, document, DETECTION_LIMITS.detections - found.length)
);
