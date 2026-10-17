import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import type { AgentSubagentsResult } from "@shared/types/ipc/agentSubagents";

// Imported first by `resourceBadge.tsx`, so the bridge is on `window` before the
// terminal service and the stores it pulls in evaluate.
//
// The agent panes' subagent chip asks `listSubagents` on mount, and the inert
// shim's `undefined` answer throws inside its cache. Answer it the way a machine
// without the CLI would, so the chip stays hidden and the page stays quiet.

const listSubagents = (): Promise<AgentSubagentsResult> =>
  Promise.resolve({ status: "unavailable", reason: "cli-missing" });

installPreviewShims({ codex: { listSubagents }, claude: { listSubagents } });

try {
  window.localStorage.clear();
  window.sessionStorage.clear();
} catch {
  // Storage can be unavailable; the harness renders without it.
}
