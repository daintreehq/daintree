import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import type { AgentSubagentsResult } from "@shared/types/ipc/agentSubagents";

// Imported first by `agentStateGlyphs.tsx`, so the bridge is on `window` before
// any store or client module evaluates. Every agent pane on the page mounts a
// subagent lookup, which reads a result shape an inert answer does not have.
const noSubagents = (): Promise<AgentSubagentsResult> =>
  Promise.resolve({ status: "ok", provider: "claude", parentId: "root-session", subagents: [] });

installPreviewShims({
  claude: { listSubagents: noSubagents },
  codex: { listSubagents: noSubagents },
});

try {
  window.localStorage.clear();
  window.sessionStorage.clear();
} catch {
  // Storage can be unavailable; the harness renders without it.
}
