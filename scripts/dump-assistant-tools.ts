#!/usr/bin/env npx tsx
/**
 * Dump Assistant Tools
 *
 * Outputs the JSON tool definitions that would be sent to the Canopy assistant.
 * This script runs independently and extracts schemas by analyzing the built code.
 *
 * Usage:
 *   npm run assistant:dump-tools
 *   npm run assistant:dump-tools -- --raw         # Include extra metadata
 *   npm run assistant:dump-tools -- --all         # Include all actions (not just allowlisted)
 *   npm run assistant:dump-tools -- --allowlist   # Just output the allowlist
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

// ============================================================================
// AGENT ACCESSIBLE ACTIONS (copied from electron/services/assistant/actionTools.ts)
// This is the allowlist of actions exposed to the AI assistant
// ============================================================================

const AGENT_ACCESSIBLE_ACTIONS = [
  // ===== QUERY ACTIONS =====
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
  "actions.list",
  "actions.getContext",
  "cliAvailability.get",

  // ===== GIT/GITHUB READ OPERATIONS =====
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
  "system.checkCommand",
  "system.checkDirectory",
  "system.getHomeDir",
  "files.search",

  // ===== CONTEXT GENERATION =====
  "copyTree.getFileTree",

  // ===== AGENT LAUNCHING =====
  "agent.launch",
  "agent.claude",
  "agent.codex",
  "agent.gemini",
  "agent.opencode",
  "agent.terminal",
  "agent.focusNextFailed",
  "agent.focusNextWaiting",
  "agent.palette",

  // ===== TERMINAL OPERATIONS =====
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

  // Terminal-to-worktree actions
  "terminal.openWorktreeEditor",
  "terminal.openWorktreePR",
  "terminal.openWorktreeIssue",

  // ===== WORKTREE OPERATIONS =====
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
  "worktree.openEditor",
  "worktree.openIssue",
  "worktree.openPR",
  "worktree.openPRInSidecar",
  "worktree.openIssueInSidecar",

  // Worktree context
  "worktree.inject",

  // Worktree sessions
  "worktree.sessions.minimizeAll",
  "worktree.sessions.maximizeAll",
  "worktree.sessions.resetRenderers",

  // ===== NOTES =====
  "notes.create",
  "notes.reveal",
  "notes.openPalette",

  // ===== SIDECAR/BROWSER NAVIGATION =====
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
  "sidecar.setLayoutMode",
  "sidecar.setDefaultNewTab",
  "sidecar.tabs.reorder",

  // Sidecar links management
  "sidecar.links.add",
  "sidecar.links.update",
  "sidecar.links.reorder",
  "sidecar.links.toggle",
  "sidecar.links.rescan",

  // Browser (panel variant)
  "browser.back",
  "browser.forward",
  "browser.reload",
  "browser.navigate",
  "browser.copyUrl",

  // ===== PROJECT OPERATIONS =====
  "project.add",
  "project.switcherPalette",
  "project.openDialog",
  "project.settings.open",

  // ===== UI OPERATIONS =====
  "app.settings",
  "app.settings.openTab",
  "nav.toggleSidebar",
  "panel.toggleDock",
  "panel.dockSetExpanded",
  "panel.dockSetCompact",
  "panel.dockCycleMode",
  "modal.close",

  // ===== CONFIG READ-ONLY =====
  "terminalConfig.get",
  "worktreeConfig.get",
  "agentSettings.get",
  "hibernation.getConfig",
  "keybinding.getOverrides",

  // ===== RECIPE EXECUTION =====
  "recipe.run",
] as const;

// ============================================================================
// LISTENER TOOLS (from electron/services/assistant/listenerTools.ts)
// ============================================================================

const LISTENER_TOOLS = [
  {
    name: "register_listener",
    description:
      "Subscribe to Canopy events. Returns a listener ID for later removal. " +
      "Use this to monitor terminal activity, agent state changes, worktree updates, and more. " +
      "For terminal:state-changed, you can filter by terminalId and toState (e.g., 'completed').",
    inputSchema: {
      type: "object",
      properties: {
        eventType: {
          type: "string",
          description:
            "The event type to subscribe to (e.g., 'agent:state-changed', 'terminal:activity')",
        },
        filter: {
          type: "object",
          description:
            "Optional filter to narrow events by field values (e.g., { terminalId: 'abc' })",
          additionalProperties: {
            type: ["string", "number", "boolean", "null"],
          },
        },
      },
      required: ["eventType"],
    },
  },
  {
    name: "list_listeners",
    description:
      "List all active event listeners for this conversation. " +
      "Shows what events you are currently subscribed to.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "remove_listener",
    description:
      "Unsubscribe from events by listener ID. " +
      "Use the listener ID returned from register_listener or list_listeners.",
    inputSchema: {
      type: "object",
      properties: {
        listenerId: {
          type: "string",
          description: "The listener ID to remove",
        },
      },
      required: ["listenerId"],
    },
  },
];

// ============================================================================
// SCHEMA SANITIZATION (from electron/services/assistant/actionTools.ts)
// ============================================================================

function sanitizeToolName(name: string): string {
  return name.replace(/\./g, "_");
}

function sanitizePropertySchema(propSchema: unknown): unknown {
  if (typeof propSchema !== "object" || propSchema === null) {
    return propSchema;
  }

  const schema = propSchema as Record<string, unknown>;

  if (Object.keys(schema).length === 0) {
    return { type: "object", additionalProperties: true };
  }

  if (!schema["type"] && !schema["anyOf"] && !schema["oneOf"] && !schema["allOf"]) {
    if (schema["properties"]) {
      return { type: "object", ...schema };
    }
    return { type: "object", additionalProperties: true, ...schema };
  }

  if (schema["properties"] && typeof schema["properties"] === "object") {
    const sanitizedProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema["properties"] as Record<string, unknown>)) {
      sanitizedProps[key] = sanitizePropertySchema(value);
    }
    return { ...schema, properties: sanitizedProps };
  }

  if (schema["anyOf"] && Array.isArray(schema["anyOf"])) {
    return {
      ...schema,
      anyOf: (schema["anyOf"] as unknown[]).map((s) => sanitizePropertySchema(s)),
    };
  }

  return schema;
}

function sanitizeSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
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

  // Recursively sanitize all properties
  if (sanitized["properties"] && typeof sanitized["properties"] === "object") {
    const sanitizedProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(sanitized["properties"] as Record<string, unknown>)) {
      sanitizedProps[key] = sanitizePropertySchema(value);
    }
    sanitized["properties"] = sanitizedProps;
  }

  return sanitized;
}

// ============================================================================
// ACTION SCHEMA EXTRACTION
// ============================================================================

interface ActionInfo {
  id: string;
  title: string;
  description: string;
  category: string;
  kind: "command" | "query";
  danger: "safe" | "confirm" | "restricted";
  inputSchema?: Record<string, unknown>;
}

/**
 * Extract a balanced brace block starting from a given position.
 * Returns the content inside the braces (excluding the outer braces).
 */
function extractBalancedBlock(content: string, startIndex: number): { block: string; endIndex: number } | null {
  if (content[startIndex] !== "{" && content[startIndex] !== "(") return null;

  const openChar = content[startIndex];
  const closeChar = openChar === "{" ? "}" : ")";

  let depth = 0;
  let inString = false;
  let stringChar = "";
  let inTemplate = false;
  let templateDepth = 0;

  for (let i = startIndex; i < content.length; i++) {
    const char = content[i];
    const prevChar = i > 0 ? content[i - 1] : "";

    // Handle string detection
    if (!inString && !inTemplate && (char === '"' || char === "'" || char === "`")) {
      if (char === "`") {
        inTemplate = true;
        templateDepth = 1;
      } else {
        inString = true;
        stringChar = char;
      }
      continue;
    }

    if (inString) {
      if (char === stringChar && prevChar !== "\\") {
        inString = false;
      }
      continue;
    }

    if (inTemplate) {
      if (char === "`" && prevChar !== "\\") {
        templateDepth--;
        if (templateDepth === 0) inTemplate = false;
      } else if (char === "$" && content[i + 1] === "{") {
        templateDepth++;
      }
      continue;
    }

    // Count braces
    if (char === openChar) depth++;
    if (char === closeChar) depth--;

    if (depth === 0) {
      return {
        block: content.slice(startIndex + 1, i),
        endIndex: i,
      };
    }
  }

  return null;
}

/**
 * Extract action information from TypeScript source files.
 * Uses a brace-counting parser to handle nested structures.
 */
function extractActionsFromSource(): ActionInfo[] {
  const actions: ActionInfo[] = [];
  const definitionsDir = path.join(ROOT, "src/services/actions/definitions");

  const files = fs.readdirSync(definitionsDir).filter((f) => f.endsWith(".ts") && f !== "schemas.ts");

  for (const file of files) {
    const content = fs.readFileSync(path.join(definitionsDir, file), "utf-8");

    // Find all actions.set() calls
    const actionSetPattern = /actions\.set\s*\(\s*["']([^"']+)["']\s*,\s*\(\s*\)\s*=>\s*\(/g;

    let match;
    while ((match = actionSetPattern.exec(content)) !== null) {
      const actionId = match[1];
      const blockStart = match.index + match[0].length - 1; // Position of opening (

      // Extract the balanced block
      const result = extractBalancedBlock(content, blockStart);
      if (!result) continue;

      const bodyRaw = result.block;

      // Extract fields from the action body
      const titleMatch = bodyRaw.match(/title:\s*["']([^"']+)["']/);
      const descMatch =
        bodyRaw.match(/description:\s*["']([^"']*(?:\\.[^"']*)*)["']/s) ||
        bodyRaw.match(/description:\s*`([^`]*)`/s) ||
        bodyRaw.match(/description:\s*\n?\s*["']([^"]+)["']/s);
      const categoryMatch = bodyRaw.match(/category:\s*["']([^"']+)["']/);
      const kindMatch = bodyRaw.match(/kind:\s*["']([^"']+)["']/);
      const dangerMatch = bodyRaw.match(/danger:\s*["']([^"']+)["']/);

      // Extract description that might span multiple lines with concatenation
      let description = descMatch?.[1]?.replace(/\s+/g, " ").trim() || "";
      if (!description) {
        // Try to match multi-line description with string concatenation
        const multiLineDesc = bodyRaw.match(/description:\s*\n?\s*["']([^"']+)["']\s*\+?\s*\n?\s*["']?([^"']*)?["']?/s);
        if (multiLineDesc) {
          description = (multiLineDesc[1] + (multiLineDesc[2] || "")).replace(/\s+/g, " ").trim();
        }
      }

      // Schema extraction - look for argsSchema: z.object({...}) or z.something().optional()
      let inputSchema: Record<string, unknown> | undefined;

      // Find argsSchema position
      const argsSchemaMatch = bodyRaw.match(/argsSchema:\s*z\./);
      if (argsSchemaMatch && argsSchemaMatch.index !== undefined) {
        const schemaStart = argsSchemaMatch.index + argsSchemaMatch[0].length - 2; // Position at 'z.'
        const schemaStr = bodyRaw.slice(schemaStart);

        // Check for z.object pattern
        if (schemaStr.startsWith("z.object")) {
          const objStart = schemaStr.indexOf("{");
          if (objStart !== -1) {
            const objResult = extractBalancedBlock(schemaStr, objStart);
            if (objResult) {
              inputSchema = parseZodObjectSchema(objResult.block);
            }
          }
        } else {
          // Has a schema but it's not a simple object - mark as generic
          inputSchema = { type: "object", additionalProperties: true };
        }
      }

      actions.push({
        id: actionId,
        title: titleMatch?.[1] || actionId,
        description,
        category: categoryMatch?.[1] || "unknown",
        kind: (kindMatch?.[1] as "command" | "query") || "command",
        danger: (dangerMatch?.[1] as "safe" | "confirm" | "restricted") || "safe",
        inputSchema,
      });
    }
  }

  return actions;
}

/**
 * Parse a simplified Zod object schema definition into JSON Schema.
 * This handles common patterns but won't cover all edge cases.
 */
function parseZodObjectSchema(schemaBody: string): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  // Match property definitions like: propName: z.string().describe("...")
  const propPattern = /(\w+)\s*:\s*z\.(\w+)\s*\(\s*([^)]*)\s*\)([^,\n]*)/g;

  let match;
  while ((match = propPattern.exec(schemaBody)) !== null) {
    const [, propName, zodType, zodArgs, modifiers] = match;

    const isOptional = modifiers.includes(".optional()");
    const descMatch = modifiers.match(/\.describe\s*\(\s*["']([^"']+)["']\s*\)/);
    const description = descMatch?.[1];

    // Convert Zod type to JSON Schema type
    let jsonType: string;
    let enumValues: string[] | undefined;
    let additionalProps: Record<string, unknown> = {};

    switch (zodType) {
      case "string":
        jsonType = "string";
        break;
      case "number":
        jsonType = "number";
        if (modifiers.includes(".int()")) {
          additionalProps.type = "integer";
          jsonType = "integer";
        }
        break;
      case "boolean":
        jsonType = "boolean";
        break;
      case "array":
        jsonType = "array";
        break;
      case "object":
        jsonType = "object";
        break;
      case "enum":
        jsonType = "string";
        // Parse enum values from zodArgs
        const enumMatch = zodArgs.match(/\[\s*["']([^"'\]]+(?:["']\s*,\s*["'][^"'\]]+)*)["']\s*\]/);
        if (enumMatch) {
          enumValues = enumMatch[1].split(/["']\s*,\s*["']/).map((s) => s.trim());
        }
        break;
      case "literal":
        // Could be string or number literal
        if (zodArgs.match(/["']/)) {
          jsonType = "string";
          enumValues = [zodArgs.replace(/["']/g, "").trim()];
        } else {
          jsonType = "number";
        }
        break;
      default:
        jsonType = "string"; // fallback
    }

    const propSchema: Record<string, unknown> = { type: jsonType };
    if (description) propSchema.description = description;
    if (enumValues) propSchema.enum = enumValues;
    Object.assign(propSchema, additionalProps);

    properties[propName] = propSchema;

    if (!isOptional) {
      required.push(propName);
    }
  }

  const schema: Record<string, unknown> = {
    type: "object",
    properties,
  };

  if (required.length > 0) {
    schema.required = required;
  }

  return schema;
}

// ============================================================================
// MAIN
// ============================================================================

interface ToolOutput {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  kind?: string;
  danger?: string;
  category?: string;
  originalId?: string;
}

function main() {
  const args = process.argv.slice(2);
  const showRaw = args.includes("--raw");
  const showAll = args.includes("--all");
  const showAllowlist = args.includes("--allowlist");
  const showHelp = args.includes("--help") || args.includes("-h");

  if (showHelp) {
    console.log(`
Dump Assistant Tools

Outputs the JSON tool definitions that would be sent to the Canopy assistant.

Usage:
  npm run assistant:dump-tools
  npm run assistant:dump-tools -- --raw         Include extra metadata (kind, danger, category)
  npm run assistant:dump-tools -- --all         Include all parsed actions (not just allowlisted)
  npm run assistant:dump-tools -- --allowlist   Just output the allowlist array
  npm run assistant:dump-tools -- --help        Show this help

Output:
  By default, outputs sanitized tools in the format sent to the LLM.
  Tools include action tools (from action definitions) and listener tools.
`);
    process.exit(0);
  }

  if (showAllowlist) {
    console.log(JSON.stringify(AGENT_ACCESSIBLE_ACTIONS, null, 2));
    process.exit(0);
  }

  // Extract actions from source
  const extractedActions = extractActionsFromSource();

  // Build tools array
  const tools: ToolOutput[] = [];
  const allowlistSet = new Set(AGENT_ACCESSIBLE_ACTIONS);

  // Filter and process actions
  const actionsToInclude = showAll
    ? extractedActions
    : extractedActions.filter((a) => allowlistSet.has(a.id as (typeof AGENT_ACCESSIBLE_ACTIONS)[number]));

  for (const action of actionsToInclude) {
    const sanitizedSchema = sanitizeSchema(action.inputSchema);
    const tool: ToolOutput = {
      name: sanitizeToolName(action.id),
      description: `[${action.kind}] ${action.description}${action.danger !== "safe" ? ` (${action.danger})` : ""}`,
      inputSchema: sanitizedSchema,
    };

    if (showRaw) {
      tool.kind = action.kind;
      tool.danger = action.danger;
      tool.category = action.category;
      tool.originalId = action.id;
    }

    tools.push(tool);
  }

  // Add actions from allowlist that weren't found in source (might be defined differently)
  const foundIds = new Set(actionsToInclude.map((a) => a.id));
  const missingFromAllowlist = AGENT_ACCESSIBLE_ACTIONS.filter((id) => !foundIds.has(id));

  if (!showAll && missingFromAllowlist.length > 0) {
    // Add placeholder entries for missing actions
    for (const actionId of missingFromAllowlist) {
      const tool: ToolOutput = {
        name: sanitizeToolName(actionId),
        description: `[action] ${actionId}`,
        inputSchema: { type: "object", properties: {} },
      };

      if (showRaw) {
        tool.originalId = actionId;
      }

      tools.push(tool);
    }
  }

  // Add listener tools
  for (const listener of LISTENER_TOOLS) {
    const tool: ToolOutput = {
      ...listener,
    };
    if (showRaw) {
      tool.kind = "command";
      tool.danger = "safe";
      tool.category = "listener";
    }
    tools.push(tool);
  }

  // Sort tools by name for consistent output
  tools.sort((a, b) => a.name.localeCompare(b.name));

  // Output summary to stderr
  console.error(`Found ${actionsToInclude.length} actions from source`);
  console.error(`Allowlist has ${AGENT_ACCESSIBLE_ACTIONS.length} actions`);
  console.error(`Missing from parsed: ${missingFromAllowlist.length}`);
  console.error(`Total tools (including listeners): ${tools.length}`);
  console.error("");

  // Output JSON to stdout
  console.log(JSON.stringify(tools, null, 2));
}

main();
