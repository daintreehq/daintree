/// <reference lib="dom" />
/**
 * Test-only extractor, built like the shipped ones: it contributes a one-record
 * component chain for any element inside a `<button>`, so a test can see an
 * extractor's answer travel the bridge and the host's admission end to end.
 */

import { installExtractor, type ExtractorHostApi } from "../../guest/registry.js";

declare const api: ExtractorHostApi;

installExtractor(api, {
  extract(element) {
    if (element.closest("button") === null) return null;
    return {
      componentChain: {
        nearestId: "fixture-1",
        components: [
          {
            componentId: "fixture-1",
            framework: "react",
            name: {
              value: "FixtureButton",
              extraction: { kind: "runtime-field", field: "type.name" },
            },
            environment: "client",
            renderParentId: null,
            rootElementIds: [],
            rootsComplete: false,
            sourceCandidates: [],
          },
        ],
        truncated: false,
      },
      capabilities: {
        names: { state: "available" },
        chain: { state: "available" },
        componentSelection: { state: "unknown" },
        file: { state: "unknown" },
        line: { state: "unknown" },
        exactRange: { state: "unknown" },
      },
    };
  },
});
