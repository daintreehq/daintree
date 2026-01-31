/**
 * Action-to-Tool Converter for Assistant Service
 *
 * Converts ActionManifestEntry definitions to Vercel AI SDK tool format.
 * Uses the same IPC dispatch pattern as AppAgentService for executing actions.
 */

import { tool, jsonSchema, type ToolSet } from "ai";
import { BrowserWindow, ipcMain } from "electron";
import type { ActionManifestEntry, ActionContext } from "../../../shared/types/actions.js";

/**
 * Allowlist of actions that the AI assistant can invoke.
 * These are carefully curated to be safe and useful for natural language commands.
 */
export const AGENT_ACCESSIBLE_ACTIONS = [
  // Query actions - return system state
  "terminal.list",
  "terminal.getOutput",
  "panel.list",
  "worktree.list",
  "worktree.getCurrent",
  "project.getCurrent",
  // Command actions - perform operations
  "app.settings",
  "app.settings.openTab",
  "terminal.new",
  "terminal.kill",
  "terminal.close",
  "terminal.trash",
  "terminal.sendCommand",
  "terminal.palette",
  "worktree.createDialog.open",
  "worktree.setActive",
  "agent.launch",
  "nav.toggleSidebar",
  "panel.toggleDock",
  "sidecar.toggle",
] as const;

export type AgentAccessibleAction = (typeof AGENT_ACCESSIBLE_ACTIONS)[number];

const MAX_RESULT_SIZE = 50000;

/**
 * Sanitize tool name for OpenAI/Fireworks compatibility.
 * Replaces dots with underscores since some providers strip dots.
 */
export function sanitizeToolName(name: string): string {
  return name.replace(/\./g, "_");
}

/**
 * Restore original action ID from sanitized tool name.
 */
export function unsanitizeToolName(sanitizedName: string): string {
  return sanitizedName.replace(/_/g, ".");
}

/**
 * Sanitize JSON Schema for AI provider compatibility.
 * Removes $schema, unwraps anyOf from Zod optionals, ensures type/properties exist.
 */
export function sanitizeSchema(
  schema: Record<string, unknown> | undefined
): Record<string, unknown> {
  const defaultSchema = { type: "object", properties: {} };

  if (!schema) {
    return defaultSchema;
  }

  const sanitized = { ...schema };

  // Remove $schema - Fireworks/OpenAI doesn't support it
  delete sanitized["$schema"];

  // Handle anyOf from .optional() - unwrap if it contains an object type
  if (sanitized["anyOf"] && Array.isArray(sanitized["anyOf"])) {
    const objectSchema = (sanitized["anyOf"] as Array<Record<string, unknown>>).find(
      (s) => s.type === "object"
    );
    if (objectSchema) {
      Object.assign(sanitized, objectSchema);
      delete sanitized["anyOf"];
    }
  }

  // Only add defaults if we don't have real structure
  if (!sanitized["type"]) {
    sanitized["type"] = "object";
  }
  if (sanitized["type"] === "object" && !sanitized["properties"]) {
    sanitized["properties"] = {};
  }

  return sanitized;
}

/**
 * Truncate and redact sensitive data from tool results.
 * Safely handles circular references and BigInt values.
 */
function truncateResult(result: unknown): unknown {
  try {
    const str = JSON.stringify(result);
    if (str.length <= MAX_RESULT_SIZE) {
      return result;
    }

    // For large results, return a truncated summary
    if (Array.isArray(result)) {
      return {
        _truncated: true,
        _originalLength: result.length,
        items: result.slice(0, 10),
        _message: `Result truncated: showing first 10 of ${result.length} items`,
      };
    }

    // For objects, try to keep the structure
    if (typeof result === "object" && result !== null) {
      const truncatedStr = str.slice(0, MAX_RESULT_SIZE);
      return {
        _truncated: true,
        _originalSize: str.length,
        _message: "Result truncated due to size",
        preview: truncatedStr.slice(0, 1000) + "...",
      };
    }

    return { _truncated: true, _message: "Result too large to display" };
  } catch (error) {
    // Handle circular references, BigInt, or other serialization errors
    const errorMessage = error instanceof Error ? error.message : "Serialization failed";
    return {
      _error: true,
      _message: `Could not serialize result: ${errorMessage}`,
      _type: typeof result,
      _isArray: Array.isArray(result),
    };
  }
}

/**
 * Dispatch an action to the renderer via IPC and wait for the result.
 * This mirrors the pattern from AppAgentService.
 */
async function dispatchAction(
  actionId: string,
  args: Record<string, unknown> | undefined,
  context: ActionContext
): Promise<{ ok: boolean; result?: unknown; error?: { code: string; message: string } }> {
  const mainWindow = BrowserWindow.getAllWindows()[0];
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { ok: false, error: { code: "NO_WINDOW", message: "Main window not available" } };
  }

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      ipcMain.removeListener("app-agent:dispatch-action-response", handler);
      resolve({ ok: false, error: { code: "TIMEOUT", message: "Action dispatch timed out" } });
    }, 30000);

    const handler = (
      _event: Electron.IpcMainEvent,
      payload: {
        requestId: string;
        result: { ok: boolean; result?: unknown; error?: { code: string; message: string } };
      }
    ) => {
      if (payload.requestId === requestId) {
        clearTimeout(timeout);
        ipcMain.removeListener("app-agent:dispatch-action-response", handler);
        resolve(payload.result);
      }
    };

    ipcMain.on("app-agent:dispatch-action-response", handler);

    mainWindow.webContents.send("app-agent:dispatch-action-request", {
      requestId,
      actionId,
      args,
      context,
    });
  });
}

/**
 * Create Vercel AI SDK tools from ActionManifestEntry definitions.
 * Only includes actions that are in the AGENT_ACCESSIBLE_ACTIONS allowlist.
 */
export function createActionTools(actions: ActionManifestEntry[], context: ActionContext): ToolSet {
  const tools: ToolSet = {};

  // Filter to only agent-accessible and enabled actions
  const agentActions = actions.filter(
    (action) =>
      AGENT_ACCESSIBLE_ACTIONS.includes(action.id as (typeof AGENT_ACCESSIBLE_ACTIONS)[number]) &&
      action.enabled
  );

  for (const action of agentActions) {
    const toolName = sanitizeToolName(action.name);
    const sanitizedSchema = sanitizeSchema(action.inputSchema);

    // Use jsonSchema() to convert JSON Schema to AI SDK format
    tools[toolName] = tool({
      description: `[${action.kind}] ${action.description}${action.danger !== "safe" ? ` (${action.danger})` : ""}`,
      inputSchema: jsonSchema<Record<string, unknown>>(sanitizedSchema),
      execute: async (args: Record<string, unknown>) => {
        const result = await dispatchAction(action.id, args, context);

        if (!result.ok) {
          return {
            success: false,
            error: result.error?.message || "Action failed",
            code: result.error?.code,
          };
        }

        return {
          success: true,
          result: truncateResult(result.result),
        };
      },
    });
  }

  return tools;
}

/**
 * Map from sanitized tool name back to action ID.
 * Used by the UI to display the original action name.
 */
export function createToolNameMap(actions: ActionManifestEntry[]): Map<string, string> {
  const map = new Map<string, string>();

  const agentActions = actions.filter(
    (action) =>
      AGENT_ACCESSIBLE_ACTIONS.includes(action.id as (typeof AGENT_ACCESSIBLE_ACTIONS)[number]) &&
      action.enabled
  );

  for (const action of agentActions) {
    const toolName = sanitizeToolName(action.name);
    map.set(toolName, action.id);
  }

  return map;
}
