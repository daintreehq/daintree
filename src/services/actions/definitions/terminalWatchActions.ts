import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import {
  TerminalCancelWatchArgsSchema,
  TerminalCancelWatchResultSchema,
  TerminalGetWatchEventsArgsSchema,
  TerminalGetWatchEventsResultSchema,
  TerminalListWatchesArgsSchema,
  TerminalListWatchesResultSchema,
  TerminalWatchArgsSchema,
  TerminalWatchResultSchema,
} from "@shared/types/terminalWatch";

function mainProcessOnly(id: string): () => Promise<never> {
  return async () => {
    throw new Error(
      `${id} must be invoked through the MCP main-process path, not renderer dispatch.`
    );
  };
}

/**
 * Terminal watches (#12491), registered here for manifest metadata only —
 * schema, description, tier and audit. Execution lives in the MCP CallTool
 * handler (electron/services/mcp-server/sessionServer.ts): which pane a call
 * comes from is known only from its MCP credential, which the renderer never
 * sees, and a watch outlives the call that made it. `run()` throws if the
 * renderer ever invokes one directly.
 */
export function registerTerminalWatchActions(
  actions: ActionRegistry,
  _callbacks: ActionCallbacks
): void {
  actions.set("terminal.registerWatch", () => ({
    id: "terminal.registerWatch",
    title: "Watch Terminals",
    description:
      "Be woken instead of polling. When a watched terminal changes agent state, prints a handback, exits or closes, Daintree types one pointer line into your own prompt once you are idle there; read what happened with the watch-events capability. Works only while the user has pane wakes turned on, and grants nothing over the watched terminals.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    denyPluginDispatch: true,
    scope: "renderer",
    keywords: ["watch", "wake", "notify", "orchestrate"],
    palette: { mode: "hidden" },
    argsSchema: TerminalWatchArgsSchema,
    resultSchema: TerminalWatchResultSchema,
    mcpOutputSchema: true,
    mcpAnnotations: {
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: false,
    },
    run: mainProcessOnly("terminal.registerWatch"),
  }));

  actions.set("terminal.listWatches", () => ({
    id: "terminal.listWatches",
    title: "List Terminal Watches",
    description:
      "List the terminal watches this pane holds: what each watches, how many wakes it has used, and whether it has stopped. Also says how many observations are waiting and where the next wake stands — held while you work, blocked at an approval or question, or outstanding until you read them.",
    category: "terminal",
    kind: "query",
    danger: "safe",
    denyPluginDispatch: true,
    scope: "renderer",
    keywords: ["watch", "wake"],
    palette: { mode: "hidden" },
    argsSchema: TerminalListWatchesArgsSchema,
    resultSchema: TerminalListWatchesResultSchema,
    mcpOutputSchema: true,
    mcpAnnotations: {
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
    },
    run: mainProcessOnly("terminal.listWatches"),
  }));

  actions.set("terminal.getWatchEvents", () => ({
    id: "terminal.getWatchEvents",
    title: "Read Terminal Watch Events",
    description:
      "Read what your terminal watches observed, as data: state changes with the detector's trigger and confidence, handbacks, exits and closes. Anything read never wakes you again, and reading lets the next wake go out. These are observations, not verdicts; check the status capability before acting on one.",
    category: "terminal",
    kind: "query",
    danger: "safe",
    denyPluginDispatch: true,
    scope: "renderer",
    keywords: ["watch", "wake", "events"],
    palette: { mode: "hidden" },
    argsSchema: TerminalGetWatchEventsArgsSchema,
    resultSchema: TerminalGetWatchEventsResultSchema,
    mcpOutputSchema: true,
    mcpAnnotations: {
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: false,
    },
    run: mainProcessOnly("terminal.getWatchEvents"),
  }));

  actions.set("terminal.cancelWatch", () => ({
    id: "terminal.cancelWatch",
    title: "Cancel Terminal Watch",
    description:
      "Stop one terminal watch this pane holds and discard its unread observations, so nothing more is typed into your prompt on its behalf. The pane's other watches keep running.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    denyPluginDispatch: true,
    scope: "renderer",
    keywords: ["watch", "wake", "cancel"],
    palette: { mode: "hidden" },
    argsSchema: TerminalCancelWatchArgsSchema,
    resultSchema: TerminalCancelWatchResultSchema,
    mcpOutputSchema: true,
    mcpAnnotations: {
      readOnlyHint: false,
      idempotentHint: true,
      destructiveHint: false,
    },
    run: mainProcessOnly("terminal.cancelWatch"),
  }));
}
