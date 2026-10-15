import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import type { CodexFolderSessionsResult } from "@shared/types/ipc/agentSubagents";
import { requireFindSessionFixture } from "./findCodexSessionFixtures";

// Imported first by `findCodexSession.tsx`, so the bridge is on `window` before
// any store or client module evaluates.
//
// `codex.findSessions` is answered for real because it IS the seam: the
// popover asks it through `codexClient` exactly as it does in the app. An inert
// answer there would render as "unavailable", which is the one picture this
// harness must never produce by accident.

const params = new URLSearchParams(window.location.search);
const fixture = requireFindSessionFixture(params.get("fixture") ?? "three");
const NOW = Date.now();

function findSessions(): Promise<CodexFolderSessionsResult> {
  if (fixture.result === "pending") return new Promise(() => {});
  if (fixture.result === "unavailable") {
    return Promise.resolve({ status: "unavailable", reason: fixture.reason ?? "timeout" });
  }
  return Promise.resolve({
    status: "ok",
    sessions: (fixture.sessions ?? []).map(({ agoMs, ...rest }) => ({
      ...rest,
      updatedAt: NOW - agoMs,
    })),
  });
}

installPreviewShims({ codex: { findSessions } });

try {
  window.localStorage.clear();
  window.sessionStorage.clear();
} catch {
  // Storage can be unavailable; the harness renders without it.
}
