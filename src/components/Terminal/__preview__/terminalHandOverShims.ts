import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import type { TerminalAdoptionResult } from "@shared/types/ipc/mcpServer";

// Imported first by `terminalHandOver.tsx`, so the bridge is on `window` before
// any store or client module evaluates.
//
// `mcpServer.adoptTerminal` is answered for real, because it is the dialog's
// seam: `?refuse=already-handed` makes the confirm come back refused, the way
// main answers when another pane already holds the terminal. The header's
// subagent chip asks its provider on mount, so that answers "none". Everything
// else degrades to inert.

const params = new URLSearchParams(window.location.search);
const refuse = params.get("refuse");

function adoptTerminal(): Promise<TerminalAdoptionResult> {
  if (refuse === "already-handed") {
    return Promise.resolve({
      status: "refused",
      reason: "already-handed",
      heldByPaneId: "t-other",
    });
  }
  return new Promise<TerminalAdoptionResult>(() => {});
}

const noSubagents = {
  listSubagents: () => Promise.resolve({ status: "ok", parentId: "root", subagents: [] }),
};

installPreviewShims({
  codex: noSubagents,
  claude: noSubagents,
  mcpServer: new Proxy(
    { adoptTerminal },
    { get: (target, key) => (key in target ? Reflect.get(target, key) : () => Promise.resolve()) }
  ),
});
