// @vitest-environment jsdom
// Before anything renders, as `@preact/preset-vite` injects it into a dev entry.
import "preact/debug";
import { describePreactExtractor } from "./preactExtractorSuite.js";

describePreactExtractor(true);
