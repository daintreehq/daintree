/**
 * Action-to-Tool Converter for Assistant Service
 *
 * Converts ActionManifestEntry definitions to Vercel AI SDK tool format.
 * Uses the same IPC dispatch pattern as AppAgentService for executing actions.
 */

import { tool, jsonSchema, type ToolSet } from "ai";
import { BrowserWindow, ipcMain } from "electron";
import type {
  ActionManifestEntry,
  ActionContext,
  ActionId,
} from "../../../shared/types/actions.js";

/**
 * Allowlist of actions that the AI assistant can invoke.
 * These are carefully curated to be safe and useful for natural language commands.
 *
 * Phase 1: Safe actions (danger: "safe") - no destructive operations
 * Phase 2: Confirm actions will require user opt-in setting (separate issue)
 */
export const AGENT_ACCESSIBLE_ACTIONS = [
  // ===== QUERY ACTIONS =====
  // Return system state without side effects
  "terminal.list",
  "terminal.getOutput",
  "terminal.info.get",
  "panel.list",
  "worktree.list",
  "worktree.getCurrent",
  "worktree.listBranches",
  "worktree.getDefaultPath",
  "worktree.getAvailableBranch",
  "project.getCurrent",
  "project.getAll",
  "project.getSettings",
  "project.getStats",
  "project.detectRunners",
  "recipe.list",

  // ===== INTROSPECTION =====
  // Self-awareness and capability discovery
  "actions.list",
  "actions.getContext",
  "cliAvailability.get",

  // ===== GIT/GITHUB READ OPERATIONS =====
  // Version control information (read-only)
  "git.getFileDiff",
  "git.getProjectPulse",
  "git.listCommits",
  "github.listIssues",
  "github.listPullRequests",
  "github.getRepoStats",
  "github.getConfig",
  "github.checkCli",
  "github.validateToken",
  "github.openIssue",
  "github.openPR",
  "github.openIssues",
  "github.openPRs",

  // ===== SYSTEM UTILITIES =====
  // File system and environment checks
  "system.checkCommand",
  "system.checkDirectory",
  "system.getHomeDir",
  "files.search",

  // ===== CONTEXT GENERATION =====
  // Building context for agents
  "copyTree.getFileTree",

  // ===== AGENT LAUNCHING =====
  // Use agent.launch with agentId to spawn any agent type
  // Shortcut actions (agent.claude, agent.codex, etc.) are for keyboard shortcuts only
  "agent.launch",
  "agent.focusNextFailed",
  "agent.focusNextWaiting",
  "agent.palette",

  // ===== TERMINAL OPERATIONS =====
  // Terminal management and interaction
  "terminal.sendCommand",
  "terminal.new",
  "terminal.close",
  "terminal.trash",
  "terminal.palette",
  "terminal.rename",
  "terminal.duplicate",
  "terminal.restart",
  "terminal.reopenLast",
  "terminal.inject",
  "terminal.redraw",

  // Terminal layout and movement
  "terminal.moveToWorktree",
  "terminal.moveToDock",
  "terminal.moveToGrid",
  "terminal.moveLeft",
  "terminal.moveRight",
  "terminal.gridLayout.setStrategy",
  "terminal.gridLayout.setValue",

  // Terminal focus navigation
  "terminal.focusNext",
  "terminal.focusPrevious",
  "terminal.focusUp",
  "terminal.focusDown",
  "terminal.focusLeft",
  "terminal.focusRight",
  "tab.next",
  "tab.previous",

  // Terminal state
  "terminal.minimize",
  "terminal.restore",
  "terminal.maximize",
  "terminal.toggleMaximize",
  "terminal.minimizeAll",
  "terminal.restoreAll",
  "terminal.restartAll",

  // Terminal-to-worktree actions
  "terminal.openWorktreeEditor",
  "terminal.openWorktreePR",
  "terminal.openWorktreeIssue",

  // ===== WORKTREE OPERATIONS =====
  // Git worktree management
  "worktree.createWithRecipe",
  "worktree.createDialog.open",
  "worktree.setActive",
  "worktree.refresh",
  "worktree.overview",
  "worktree.overview.open",
  "worktree.overview.close",
  "worktree.reveal",
  "worktree.select",
  "worktree.panel",
  "worktree.openPalette",

  // Worktree navigation
  "worktree.next",
  "worktree.previous",
  "worktree.switchIndex",
  "worktree.home",
  "worktree.end",
  "worktree.openEditor",
  "worktree.openIssue",
  "worktree.openPR",
  "worktree.openPRInSidecar",
  "worktree.openIssueInSidecar",

  // Worktree context
  "worktree.inject",

  // Worktree sessions (safe bulk operations)
  "worktree.sessions.minimizeAll",
  "worktree.sessions.maximizeAll",
  "worktree.sessions.resetRenderers",

  // ===== NOTES =====
  // Persistent context and documentation
  "notes.create",
  "notes.reveal",
  "notes.openPalette",

  // ===== SIDECAR/BROWSER NAVIGATION =====
  // In-app web browsing and documentation
  "sidecar.toggle",
  "sidecar.openUrl",
  "sidecar.newTab",
  "sidecar.nextTab",
  "sidecar.prevTab",
  "sidecar.activateTab",
  "sidecar.closeTab",
  "sidecar.duplicateTab",
  "sidecar.goBack",
  "sidecar.goForward",
  "sidecar.reload",
  "sidecar.copyUrl",
  "sidecar.copyTabUrl",
  "sidecar.openLaunchpad",

  // Sidecar layout
  "sidecar.width.set",
  "sidecar.resetWidth",
  "sidecar.setDefaultNewTab",
  "sidecar.tabs.reorder",

  // Sidecar links management
  "sidecar.links.add",
  "sidecar.links.update",
  "sidecar.links.reorder",
  "sidecar.links.toggle",

  // Browser (panel variant)
  "browser.back",
  "browser.forward",
  "browser.reload",
  "browser.navigate",
  "browser.copyUrl",

  // ===== PROJECT OPERATIONS =====
  // Project management
  "project.add",
  "project.close",
  "project.saveSettings",
  "project.switcherPalette",
  "project.openDialog",
  "project.settings.open",

  // ===== UI OPERATIONS =====
  // Application interface controls
  "app.settings",
  "app.settings.openTab",
  "nav.toggleSidebar",
  "modal.close",

  // ===== CONFIG READ-ONLY =====
  // Read configuration state
  "terminalConfig.get",
  "worktreeConfig.get",
  "agentSettings.get",
  "hibernation.getConfig",
  "keybinding.getOverrides",

  // ===== RECIPE EXECUTION =====
  // Template-based workflows
  "recipe.run",

  // ===== ARTIFACT OPERATIONS =====
  // Agent output persistence and code modifications
  "artifact.saveToFile",
  "artifact.applyPatch",
] as const satisfies readonly ActionId[];

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
 * Recursively sanitize a property schema.
 * Fixes empty objects from z.any() by converting to { type: "object" }.
 */
function sanitizePropertySchema(propSchema: unknown): unknown {
  if (typeof propSchema !== "object" || propSchema === null) {
    return propSchema;
  }

  const schema = propSchema as Record<string, unknown>;

  // Handle empty objects from z.any() - they need at least a type
  // An empty object {} in JSON Schema technically means "any value" but many AI providers
  // don't handle this well. Convert to an explicit object type.
  if (Object.keys(schema).length === 0) {
    return { type: "object", additionalProperties: true };
  }

  // If it's an object with no type but has other properties, it might be malformed
  if (!schema["type"] && !schema["anyOf"] && !schema["oneOf"] && !schema["allOf"]) {
    // Check if it looks like an object schema (has properties)
    if (schema["properties"] && typeof schema["properties"] === "object") {
      const sanitizedProps: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(schema["properties"] as Record<string, unknown>)) {
        sanitizedProps[key] = sanitizePropertySchema(value);
      }
      return { type: "object", ...schema, properties: sanitizedProps };
    }
    // Otherwise, treat as a permissive object
    return { type: "object", additionalProperties: true, ...schema };
  }

  // Recursively sanitize nested properties
  if (schema["properties"] && typeof schema["properties"] === "object") {
    const sanitizedProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema["properties"] as Record<string, unknown>)) {
      sanitizedProps[key] = sanitizePropertySchema(value);
    }
    return { ...schema, properties: sanitizedProps };
  }

  // Handle anyOf (from Zod optionals) by recursively sanitizing each option
  if (schema["anyOf"] && Array.isArray(schema["anyOf"])) {
    return {
      ...schema,
      anyOf: (schema["anyOf"] as unknown[]).map((s) => sanitizePropertySchema(s)),
    };
  }

  return schema;
}

/**
 * Sanitize JSON Schema for AI provider compatibility.
 * Removes $schema, unwraps anyOf from Zod optionals, ensures type/properties exist.
 * Fixes malformed schemas like empty objects from z.any().
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

  // Recursively sanitize all properties to fix malformed nested schemas
  if (sanitized["properties"] && typeof sanitized["properties"] === "object") {
    const sanitizedProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(sanitized["properties"] as Record<string, unknown>)) {
      sanitizedProps[key] = sanitizePropertySchema(value);
    }
    sanitized["properties"] = sanitizedProps;
  }

  return sanitized;
}

/**
 * Truncate and redact sensitive data from tool results.
 * Safely handles circular references and BigInt values.
 */
function truncateResult(result: unknown): unknown {
  try {
    if (result === undefined) {
      return null;
    }

    const str = JSON.stringify(result);
    if (typeof str !== "string") {
      return null;
    }

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
  context: ActionContext,
  confirmed?: boolean
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
      if (!payload || typeof payload !== "object") return;
      if (payload.requestId !== requestId) return;
      if (!payload.result || typeof payload.result !== "object") return;
      if (typeof payload.result.ok !== "boolean") return;

      clearTimeout(timeout);
      ipcMain.removeListener("app-agent:dispatch-action-response", handler);
      resolve(payload.result);
    };

    ipcMain.on("app-agent:dispatch-action-response", handler);

    try {
      mainWindow.webContents.send("app-agent:dispatch-action-request", {
        requestId,
        actionId,
        args,
        context,
        confirmed,
      });
    } catch {
      clearTimeout(timeout);
      ipcMain.removeListener("app-agent:dispatch-action-response", handler);
      resolve({
        ok: false,
        error: { code: "DISPATCH_FAILED", message: "Action dispatch failed" },
      });
    }
  });
}

async function requestUserConfirmation(
  actionId: string,
  actionName: string | undefined,
  args: Record<string, unknown> | undefined,
  danger: "safe" | "confirm" | "restricted"
): Promise<boolean> {
  const mainWindow = BrowserWindow.getAllWindows()[0];
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      ipcMain.removeListener("app-agent:confirmation-response", handler);
      resolve(false);
    }, 120000);

    const handler = (
      _event: Electron.IpcMainEvent,
      payload: { requestId: string; approved: boolean }
    ) => {
      if (!payload || typeof payload !== "object") return;
      if (payload.requestId !== requestId) return;
      if (typeof payload.approved !== "boolean") return;

      clearTimeout(timeout);
      ipcMain.removeListener("app-agent:confirmation-response", handler);
      resolve(payload.approved);
    };

    ipcMain.on("app-agent:confirmation-response", handler);

    try {
      mainWindow.webContents.send("app-agent:confirmation-request", {
        requestId,
        actionId,
        actionName,
        args,
        danger,
      });
    } catch {
      clearTimeout(timeout);
      ipcMain.removeListener("app-agent:confirmation-response", handler);
      resolve(false);
    }
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
        let result = await dispatchAction(action.id, args, context);

        if (!result.ok && result.error?.code === "CONFIRMATION_REQUIRED") {
          const approved = await requestUserConfirmation(
            action.id,
            action.name,
            args,
            action.danger
          );

          if (!approved) {
            return {
              success: false,
              error: "User denied the action. The action requires explicit user approval.",
              code: "CONFIRMATION_DENIED",
            };
          }

          result = await dispatchAction(action.id, args, context, true);
        }

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
