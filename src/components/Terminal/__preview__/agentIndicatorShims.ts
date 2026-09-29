import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import type { AgentSubagentsResult } from "@shared/types/ipc/agentSubagents";

// Imported first by `agentIndicator.tsx`, so the bridge is on `window` before
// any store or client module evaluates. Every state under review is seeded
// straight into the panel store; the one call answered for real is the header's
// subagent lookup, which reads a result shape an inert answer does not have.
const noSubagents = (): Promise<AgentSubagentsResult> =>
  Promise.resolve({ status: "ok", provider: "claude", parentId: "root-session", subagents: [] });

installPreviewShims({ claude: { listSubagents: noSubagents } });

try {
  window.localStorage.clear();
  window.sessionStorage.clear();
} catch {
  // Storage can be unavailable; the harness renders without it.
}
