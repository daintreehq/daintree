import {
  answerPaneCorrection,
  answerPaneFileCandidates,
  answerPaneProject,
  answerPaneStart,
  type HostPaneDeps,
} from "../../services/voice/paneContext.js";
import { getPtyClient, getWorkspaceClientRef } from "../../window/serviceRefs.js";
import { installVoicePaneHostWith, type VoicePaneSessionSource } from "./host.js";

// Read per request: the pty-host and workspace host may come up after the listener.
function hostPaneDeps(): HostPaneDeps {
  return {
    ptyClient: getPtyClient() ?? undefined,
    worktreeService: getWorkspaceClientRef() ?? undefined,
  };
}

/** Read this host's panes for the Shells dictating into them. */
export function installVoicePaneHost(server: VoicePaneSessionSource): () => void {
  return installVoicePaneHostWith(server, {
    readStart: (scope, budgetMs) => answerPaneStart(hostPaneDeps(), scope, budgetMs),
    readCorrection: (scope, budgetMs) => answerPaneCorrection(hostPaneDeps(), scope, budgetMs),
    findFileCandidates: (scope, descriptions, budgetMs) =>
      answerPaneFileCandidates(hostPaneDeps(), scope, descriptions, budgetMs),
    readProject: answerPaneProject,
  });
}
