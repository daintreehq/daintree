import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import type { AgentSubagentsResult } from "@shared/types/ipc/agentSubagents";

// Imported first by `pausedOutput.tsx`, so the bridge is on `window` before any
// store or client module evaluates.
//
// An agent pane's header asks its provider for subagents on mount; the inert
// shim resolves `undefined` there and the hook throws on every settle. An empty
// list is the honest answer for a pane that has none.
const listSubagents = (): Promise<AgentSubagentsResult> =>
  Promise.resolve({ status: "ok", provider: "claude", parentId: "root-session", subagents: [] });

installPreviewShims({ claude: { listSubagents } });

try {
  window.localStorage.clear();
  window.sessionStorage.clear();
} catch {
  // Storage can be unavailable; the harness renders without it.
}
