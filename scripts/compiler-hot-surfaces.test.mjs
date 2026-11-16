// Pins React Compiler compiling the components and hooks that render on every
// app-shell interaction. One unsupported construct anywhere in a component —
// a `try` with a `finally`, a function expression that names itself — and the
// compiler abandons all of it, silently: nothing fails at runtime, the
// component just re-renders with everything above it. The toolbar and every
// Canopy surface sat uncompiled that way, and the switcher's mutation hooks
// handed the app root fresh actions on each pane focus, re-rendering the
// toolbar and the modal host on every click between panes (#17056).
//
// The budget gate pools these into a repo-wide total, where a regression here
// can be offset by an improvement anywhere else; this test cannot be.

import { describe, it, expect } from "vitest";
import { compilerEventsFor } from "./lib/compiler-scan.mjs";

// Each file, with the functions that must come out compiled. Naming them is
// what keeps the test from passing on a file the compiler skipped outright.
const SURFACES = {
  "src/components/Layout/Toolbar.tsx": ["Toolbar"],
  "src/hooks/projectSwitcher/useProjectSwitcherProjectMutations.ts": [
    "useProjectSwitcherProjectMutations",
  ],
  "src/hooks/projectSwitcher/useProjectSwitcherScratchMutations.ts": [
    "useProjectSwitcherScratchMutations",
  ],
  "src/hooks/useProjectSwitcherPalette.ts": ["useProjectSwitcherPalette"],
  "src/components/Canopy/CanopyView.tsx": ["CanopyView", "CanopyPanel", "CanopyInbox"],
  "src/components/Canopy/CanopyCard.tsx": ["CanopyCard"],
  "src/components/Canopy/useCanopyInboxActions.ts": ["useCanopyInboxActions"],
};

function describeFailure(event) {
  const detail = event.detail ?? {};
  const loc = typeof detail.primaryLocation === "function" ? detail.primaryLocation() : detail.loc;
  const line = loc?.start?.line ?? event.fnLoc?.start?.line ?? "?";
  return `${event.kind} :${line} ${detail.reason ?? event.reason ?? event.data ?? ""}`;
}

describe("React Compiler on the app shell's hot surfaces", () => {
  for (const [file, expected] of Object.entries(SURFACES)) {
    // A large component takes a few seconds to compile on a loaded runner.
    it(`compiles ${file} with no bailouts`, { timeout: 60_000 }, async () => {
      const events = await compilerEventsFor(file);
      const failures = events
        .filter((e) => ["CompileError", "CompileSkip", "PipelineError"].includes(e.kind))
        .map(describeFailure);
      expect(failures).toEqual([]);
      const compiled = events.filter((e) => e.kind === "CompileSuccess").map((e) => e.fnName);
      expect(compiled).toEqual(expect.arrayContaining(expected));
    });
  }
});
