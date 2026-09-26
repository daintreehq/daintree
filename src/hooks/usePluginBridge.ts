import { useEffect } from "react";
import { actionService } from "@/services/ActionService";
import type {
  ActionId,
  ActionManifestEntry,
  PluginActionManifestEntry,
} from "@shared/types/actions";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { handlePanelReloadRequest } from "@/services/plugin/pluginPanelReload";
import type { PluginPanelReloadResponse } from "@shared/types/pluginPanelReload";
import type { PluginAgentPane } from "@shared/types/plugin";
import { listAgentPanes } from "@/services/agentHandoff/agentDraft";

/**
 * Project an internal {@link ActionManifestEntry} onto the slim, IPC-safe
 * {@link PluginActionManifestEntry} exposed to plugins via `host.actions.*`
 * (#10561). Deliberately an explicit allowlist — palette state, live-context
 * fields (`enabled`/`disabledReason`), and MCP-internal classification
 * (`name`/`mcpVisibility`/`band`/`pluginId`) are dropped so internal manifest
 * shape changes don't leak across the plugin boundary.
 */
function toPluginManifestEntry(entry: ActionManifestEntry): PluginActionManifestEntry {
  return {
    id: entry.id,
    title: entry.title,
    description: entry.description,
    category: entry.category,
    kind: entry.kind,
    danger: entry.danger,
    inputSchema: entry.inputSchema,
    requiresArgs: entry.requiresArgs,
    keywords: entry.keywords,
    examples: entry.examples,
    dangerRationale: entry.dangerRationale,
  };
}

/**
 * Sets up the renderer-side plugin dispatch + action-catalog bridge.
 *
 * Listens for plugin-sourced requests from the main process and answers them
 * against the renderer-only `ActionService`:
 * - `host.dispatch()` → `actionService.dispatch` with `source: "plugin"`. Unlike
 *   the MCP bridge there is no confirmation intercept: plugins cannot bypass
 *   confirm-gating, so `danger:"confirm"` returns `CONFIRMATION_REQUIRED` and
 *   `danger:"restricted"` returns `RESTRICTED` directly from ActionService.
 * - `host.actions.list()` / `host.actions.get()` (#10561) → project
 *   `ActionService.list()`/`get()` to the slim {@link PluginActionManifestEntry}.
 *   `get()` additionally filters out `danger:"restricted"` so a single lookup
 *   matches `list()`'s "restricted is invisible to plugins" contract.
 * - `host.reloadPanel()` (#12610) → the panel's registered view, after
 *   re-validating the target against this renderer's live panel record.
 * - `host.agents.list()` → this view's agent panes, read from its own panel and
 *   worktree stores, so a project-bound plugin only ever sees its project.
 *
 * The dispatch success send sits inside the try block so a non-serializable
 * action result (a DataCloneError on `ipcRenderer.send`) is caught and replaced
 * with a serializable `EXECUTION_ERROR` envelope rather than stranding the
 * main-side pending request until its timeout.
 */
export function usePluginBridge(): void {
  useEffect(() => {
    if (!window.electron?.pluginBridge) return;

    let disposed = false;

    const cleanupDispatch = window.electron.pluginBridge.onDispatchActionRequest(
      async ({ requestId, actionId, args }) => {
        try {
          const result = await actionService.dispatch(actionId as ActionId, args, {
            source: "plugin",
          });
          if (disposed) return;
          window.electron.pluginBridge.sendDispatchActionResponse({ requestId, result });
        } catch (err) {
          if (disposed) return;
          window.electron.pluginBridge.sendDispatchActionResponse({
            requestId,
            result: {
              ok: false,
              error: {
                code: "EXECUTION_ERROR",
                message: formatErrorMessage(err, "Plugin action dispatch failed"),
              },
            },
          });
        }
      }
    );

    const cleanupActionsList = window.electron.pluginBridge.onActionsListRequest(
      ({ requestId }) => {
        if (disposed) return;
        try {
          const entries = actionService
            .list(undefined, { includeSchemas: true })
            .map(toPluginManifestEntry);
          window.electron.pluginBridge.sendActionsListResponse({ requestId, entries });
        } catch {
          window.electron.pluginBridge.sendActionsListResponse({ requestId, entries: [] });
        }
      }
    );

    const cleanupActionsGet = window.electron.pluginBridge.onActionsGetRequest(
      ({ requestId, actionId }) => {
        if (disposed) return;
        try {
          const entry = actionService.get(actionId as ActionId);
          // `get()` ignores the restricted filter that `list()` applies, so drop
          // restricted entries here to keep the single-lookup surface consistent
          // with the catalog (restricted actions are invisible to plugins).
          const projected =
            entry && entry.danger !== "restricted" ? toPluginManifestEntry(entry) : null;
          window.electron.pluginBridge.sendActionsGetResponse({ requestId, entry: projected });
        } catch {
          window.electron.pluginBridge.sendActionsGetResponse({ requestId, entry: null });
        }
      }
    );

    // Optional-chained like the panel reload below: a preload from before the
    // channel existed simply never asks, and main answers `[]` on its timeout.
    const cleanupAgentsList = window.electron.pluginBridge.onAgentsListRequest?.(
      ({ requestId }) => {
        if (disposed) return;
        let agents: PluginAgentPane[] = [];
        try {
          agents = listAgentPanes();
        } catch {
          // An empty answer is the documented "nothing to list" outcome.
        }
        window.electron.pluginBridge.sendAgentsListResponse({ requestId, agents });
      }
    );

    const cleanupPanelReload = window.electron.pluginBridge.onPanelReloadRequest?.((request) => {
      const send = (response: PluginPanelReloadResponse): void => {
        if (disposed) return;
        try {
          window.electron.pluginBridge.sendPanelReloadResponse(response);
        } catch {
          // Main settles the request as "unavailable" on its own timeout.
        }
      };
      // Always answer: an unanswered request holds the plugin's call open until
      // main's timeout.
      void handlePanelReloadRequest(request).then(send, () =>
        send({ requestId: request.requestId, result: "unavailable" })
      );
    });

    return () => {
      disposed = true;
      cleanupDispatch();
      cleanupActionsList();
      cleanupActionsGet();
      cleanupAgentsList?.();
      cleanupPanelReload?.();
    };
  }, []);
}
