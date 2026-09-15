import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { requireFixture } from "./resumeSessionFixtures";

// Imported first by `preview.tsx`, so the shim is on `window` before any store
// module evaluates — same reasoning as the panel-header harness.
//
// The one namespace answered for real is the session journal: the palette's
// data hook reads `agentSessionHistory.list()` on open, and an inert answer
// there is an honest-looking empty state, which is the one picture this
// harness must never produce by accident.
const params = new URLSearchParams(window.location.search);
const fixture = requireFixture(params.get("fixture") ?? "populated");

const isHarness = !Reflect.get(window, "electron");
installPreviewShims({
  agentSessionHistory: { list: () => Promise.resolve(fixture.sessions) },
});

if (isHarness) {
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
  } catch {
    // Storage can be unavailable; the harness renders without it.
  }
}
