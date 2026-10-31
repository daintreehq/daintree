// Integration workers stay in the node environment, so none of the unit suite's
// DOM priming (Radix loader, rAF/ResizeObserver stubs) belongs here. Only the
// guards that keep a run off the developer's real machine are shared.

import { installTestIsolation } from "./electron/__tests__/helpers/testIsolation.js";

installTestIsolation();
