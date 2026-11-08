import { CHANNELS } from "../../ipc/channels.js";
import { broadcastToProjectRenderers } from "../../ipc/utils.js";
import { getPtyClient } from "../../window/serviceRefs.js";
import { ComposerSendHold } from "./ComposerSendHold.js";

let service: ComposerSendHold | null = null;
let loading: Promise<ComposerSendHold> | null = null;

/**
 * This machine's held composer sends (#16379), made on the first hold: the
 * MCP service it queues on is loaded then, and not before.
 */
export function getComposerSendHold(): Promise<ComposerSendHold> {
  if (service) return Promise.resolve(service);
  loading ??= import("../McpServerService.js").then(({ mcpServerService }) => {
    service ??= new ComposerSendHold({
      openWakes: () => mcpServerService.holdWakes(),
      paneFor: (terminalId) => mcpServerService.workerNoticePane(terminalId),
      getLiveGeneration: (terminalId) => getPtyClient()?.getLiveGeneration(terminalId) ?? null,
      getTerminalProjectId: (terminalId) =>
        getPtyClient()?.getTerminalProjectId(terminalId) ?? null,
      readTerminal: async (terminalId) =>
        (await getPtyClient()?.getTerminalAsync(terminalId)) ?? null,
      publish: (projectId, change) =>
        broadcastToProjectRenderers(projectId, CHANNELS.COMPOSER_HOLD_CHANGED, change),
    });
    return service;
  });
  return loading;
}

/** The held sends, if anything was ever held; nothing is made to answer. */
export function peekComposerSendHold(): ComposerSendHold | null {
  return service;
}
