import { getHelpAssistantSettings } from "../../ipc/handlers/helpAssistant.js";
import { projectStore } from "../../services/ProjectStore.js";
import { resolveMcpDriveTarget } from "../../services/mcp-server/driveTarget.js";
import { viewlessActionDanger } from "../../services/viewless/viewlessActionCatalog.js";
import { createLogger } from "../../utils/logger.js";
import { stableArgsSha256 } from "../../utils/pluginMcpHash.js";
import { getPtyClient } from "../../window/serviceRefs.js";
import type { MetricsSessionSource } from "../metrics/hostMetricsHost.js";
import { auditRecordFor, installHostPluginControl, leaseStanding } from "./hostPluginControl.js";

const logger = createLogger("main:pluginControlHost");

function safeArgsHash(args: unknown): string {
  try {
    return args === undefined || args === null ? "" : stableArgsSha256([args]);
  } catch {
    return "";
  }
}

/** Takes Shells' plugin calls on this host (#16767), under its own gates. */
export function installHostPluginControlHost(server: MetricsSessionSource): () => void {
  return installHostPluginControl(server, {
    acceptsRemoteControl: () => getHelpAssistantSettings().acceptRemoteControl,
    hasProject: async (projectId) => projectStore.getProjectById(projectId) !== null,
    standing: (projectId, linkSessionId, change) =>
      leaseStanding(resolveMcpDriveTarget, projectId, linkSessionId, change),
    hasViewlessForm: (actionId) => viewlessActionDanger(actionId) !== undefined,
    // Loaded on the first call that needs it: a host no Shell's plugin reaches loads none.
    runWithoutView: async (request) => {
      const { runViewlessAction } = await import("../../services/viewless/index.js");
      return runViewlessAction(request);
    },
    audit: (entry) => {
      const record = auditRecordFor(entry, safeArgsHash(entry.args));
      void import("../../services/PluginActionAuditService.js")
        .then(({ getPluginActionAuditService }) => getPluginActionAuditService().append(record))
        .catch((error: unknown) => {
          logger.warn("Couldn't record a remote plugin's call", { error });
        });
    },
    pty: () => getPtyClient(),
  });
}
