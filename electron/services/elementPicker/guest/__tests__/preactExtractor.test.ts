// @vitest-environment jsdom
import { describePreactExtractor } from "./preactExtractorSuite.js";

// A page that never loaded `preact/debug`: names still come from the
// functions, and `__source` from the jsx-dev transform alone.
describePreactExtractor(false);
