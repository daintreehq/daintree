import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginHostApi } from "../../../../shared/types/plugin.js";
import { Catalog } from "./catalog.js";
import type { PluginContext } from "./context.js";
import { continueFromPane, launchById } from "./continueFlow.js";
import { SEARCH_TOOL_NAME } from "./handoff.js";
import { IndexStore } from "./indexStore.js";
import { manageConversions } from "./manageFlow.js";
import { createSearchTool } from "./search.js";

/**
 * Continue Session (#16097): carries a Codex session over to Claude Code, or
 * a Claude Code session over to Codex. Core's `terminal.sessionFile.get` says
 * which file the pane's agent is writing; this plugin reads it once into a
 * local full-text index, starts the other CLI in the same worktree with a
 * mechanical hand-off, and serves one MCP tool that searches the index.
 *
 * Nothing is read until the user asks for a conversion, and the source file
 * is only ever opened read-only.
 */
export async function activate(host: PluginHostApi): Promise<() => void> {
  return activateWith(host, {
    dataDir: join(homedir(), ".daintree", "plugin-data", host.pluginId),
    newId: randomUUID,
  });
}

export async function activateWith(
  host: PluginHostApi,
  options: { dataDir: string; newId: () => string }
): Promise<() => void> {
  const ctx: PluginContext = {
    host,
    catalog: new Catalog(host.storage),
    store: new IndexStore(join(options.dataDir, "sessions")),
    newId: options.newId,
    running: new Set(),
  };

  await host.registerAction(
    {
      id: "continue",
      title: "Continue in another agent",
      description:
        "Convert this pane's Codex or Claude Code session into a local searchable index and continue it in the other CLI, in the same worktree.",
      category: "Continue Session",
      kind: "command",
      danger: "safe",
      inputSchema: {
        type: "object",
        properties: {
          panelId: { type: "string" },
          panelKind: { type: "string" },
          worktreeId: { type: "string" },
        },
      },
    },
    (args) => continueFromPane(ctx, args)
  );
  await host.registerAction(
    {
      id: "launch",
      title: "Continue a converted session",
      description: "Start the continuing agent for a session that was already converted.",
      category: "Continue Session",
      kind: "command",
      danger: "safe",
      inputSchema: {
        type: "object",
        properties: { conversionId: { type: "string" } },
        required: ["conversionId"],
      },
    },
    (args) => launchById(ctx, args)
  );
  await host.registerAction(
    {
      id: "manage",
      title: "Converted sessions",
      description:
        "List this project's converted sessions with their size, share them with every agent in the project, or delete them.",
      category: "Continue Session",
      kind: "command",
      danger: "safe",
      inputSchema: { type: "object", properties: { projectId: { type: "string" } } },
    },
    (args) => manageConversions(ctx, args)
  );

  const disposeTools = await host.mcp.registerTools("sessions", {
    [SEARCH_TOOL_NAME]: createSearchTool({
      catalog: ctx.catalog,
      store: ctx.store,
      log: (message) => host.logger.warn(message),
    }),
  });

  // Leftovers of a build the plugin was stopped in the middle of. Not awaited:
  // activation stays within its budget, and nothing reads a partial file.
  void ctx.store.sweepPartials().catch(() => undefined);

  return () => {
    for (const controller of ctx.running) controller.abort();
    ctx.running.clear();
    disposeTools();
  };
}
