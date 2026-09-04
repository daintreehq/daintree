import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { defineAction } from "../defineAction";
import { z } from "zod";
import { pluginClient } from "@/clients/pluginClient";
import { parseProjectPluginInstanceKey } from "@shared/types/plugin";

/**
 * The plugin-authoring feedback loop (#12214). An agent writing a plugin into a
 * project's `.daintree/plugins/` had no way to learn whether it worked: the
 * manifest schema was reachable only from inside the host, the project re-scan
 * existed as an IPC nobody called, and the per-plugin log ring buffer fed bug
 * reports but nothing an author could read. These three close that loop, and
 * because the action manifest is also the MCP tool surface they close it for
 * the agent as well as the human.
 *
 * All three are ordinary renderer-dispatched actions rather than main-process
 * short-circuits: every capability they need is already bridged through
 * `window.electron.plugin`, so there is nothing to short-circuit past.
 */

/** Bounds the log tail so one call can't ship a whole 500-line ring buffer. */
const DIAGNOSTICS_LOG_LIMIT_DEFAULT = 50;
const DIAGNOSTICS_LOG_LIMIT_MAX = 500;

export function registerPluginActions(actions: ActionRegistry, _callbacks: ActionCallbacks): void {
  actions.set("plugin.validate", () =>
    defineAction({
      id: "plugin.validate",
      title: "Validate plugin manifest",
      description:
        "Check a plugin.json on disk against the schema Daintree actually loads with, and get back every rejection paired with the field path that caused it. The rules differ by where a plugin lives, so the reply names which set was applied and whether that came from the location on disk or from what the manifest claims about itself. Warnings are advisory and never stop a plugin loading.",
      category: "plugins",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        path: z
          .string()
          .min(1)
          .describe(
            "The plugin directory, or the manifest file itself. Absolute, or relative to the project root. Must sit inside the open project or the managed plugins directory."
          ),
      }),
      examples: [
        {
          args: { path: ".daintree/plugins/acme.dashboard" },
          description: "Check a project plugin the agent just wrote, before reloading.",
        },
        {
          args: { path: ".daintree/plugins/acme.dashboard/plugin.json" },
          description: "The same check, naming the manifest file directly.",
        },
      ],
      resultSchema: z.object({
        manifestPath: z.string(),
        origin: z.enum(["builtin", "user", "project"]),
        originSource: z.enum(["location", "declared-scope"]),
        ok: z.boolean(),
        pluginId: z.string().nullable(),
        errors: z.array(z.object({ path: z.string(), message: z.string() })),
        warnings: z.array(z.string()),
      }),
      mcpOutputSchema: true,
      mcpAnnotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
      },
      run: async (args) => pluginClient.validateManifest(args.path),
    })
  );

  actions.set("plugin.diagnostics", () =>
    defineAction({
      id: "plugin.diagnostics",
      title: "Read plugin diagnostics",
      description:
        "Report why one plugin is in the state it is in: the load or activation failure it recorded, whether it is running, and the tail of the lines it wrote through the host logger. A project plugin whose manifest was refused is reported with its rejection, so one that never loaded is distinguishable from one that does not exist. An unknown id fails, listing the ids that do exist.",
      category: "plugins",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        pluginId: z
          .string()
          .min(1)
          .describe(
            "The plugin's manifest id, in publisher.name form. For a project plugin this is the id in its manifest, not the directory it sits in."
          ),
        logLimit: z
          .number()
          .int()
          .min(1)
          .max(DIAGNOSTICS_LOG_LIMIT_MAX)
          .optional()
          .describe(
            `How many of the newest log lines to return (default ${DIAGNOSTICS_LOG_LIMIT_DEFAULT}, max ${DIAGNOSTICS_LOG_LIMIT_MAX}).`
          ),
      }),
      examples: [
        {
          args: { pluginId: "acme.dashboard" },
          description: "Find out why a plugin that should be running isn't.",
        },
        {
          args: { pluginId: "acme.dashboard", logLimit: 200 },
          description: "Pull a deeper log tail while chasing an intermittent activation failure.",
        },
      ],
      resultSchema: z.object({
        pluginId: z.string(),
        displayName: z.string(),
        version: z.string(),
        /** False when the host knows the plugin but is not running it. */
        loaded: z.boolean(),
        disabled: z.boolean(),
        devMode: z.boolean(),
        /** Project-plugin lifecycle state; null for an installed or built-in plugin. */
        projectState: z.enum(["active", "staged", "blocked", "invalid"]).nullable(),
        loadError: z
          .object({
            message: z.string(),
            stack: z.string().nullable(),
            at: z.number().nullable(),
          })
          .nullable(),
        logLines: z.array(
          z.object({
            ts: z.number(),
            level: z.enum(["info", "warn", "error"]),
            message: z.string(),
          })
        ),
        /** Lines held in the buffer, which may exceed the number returned. */
        logLinesAvailable: z.number(),
      }),
      mcpOutputSchema: true,
      mcpAnnotations: {
        readOnlyHint: true,
        idempotentHint: false,
        destructiveHint: false,
      },
      run: async (args, ctx) => {
        const limit = args.logLimit ?? DIAGNOSTICS_LOG_LIMIT_DEFAULT;
        const snapshot = await pluginClient.getDiagnosticsSnapshot();

        // A project plugin runs under an instance key
        // (`project__{projectId}__{publisher.name}`), never its bare manifest
        // id — but the manifest id is the only one its author knows, because it
        // is the one they wrote. Parse the key rather than matching its tail: a
        // suffix test also matches the SAME id owned by a different open
        // project, and the snapshot is app-global, so it would hand this
        // project's agent another project's log lines.
        const matches = (candidate: string): boolean => {
          if (candidate === args.pluginId) return true;
          const parsed = parseProjectPluginInstanceKey(candidate);
          if (!parsed || parsed.manifestId !== args.pluginId) return false;
          // Only this caller's own project. Without a project on the sender
          // there is no owner to compare against, so no instance key qualifies.
          return ctx.projectId !== undefined && parsed.projectId === ctx.projectId;
        };
        const entry = snapshot.plugins.find((p) => matches(p.pluginId));

        if (entry) {
          // Rebuilt field by field rather than spread: the snapshot entry also
          // carries install provenance and the action audit trail, neither of
          // which belongs in an authoring diagnostic.
          return {
            // The id the caller asked with, not the instance key it happens to
            // run under — the key names a project and is not theirs to hold.
            pluginId: args.pluginId,
            displayName: entry.displayName,
            version: entry.version,
            loaded: true,
            disabled: entry.disabled,
            devMode: entry.devMode,
            projectState: null,
            loadError: entry.loadError
              ? {
                  message: entry.loadError.message,
                  stack: entry.loadError.stack ?? null,
                  at: entry.loadError.at ?? null,
                }
              : null,
            logLines: entry.logLines.slice(-limit).map((line) => ({
              ts: line.ts,
              level: line.level,
              message: line.message,
            })),
            logLinesAvailable: entry.logLines.length,
          };
        }

        // The snapshot only covers plugins the host is running, and the case an
        // author hits most is the one it therefore omits: a manifest the
        // project refused. Fall back to the project's own list so a rejected
        // plugin reports its rejection instead of reading as nonexistent.
        const projectPlugins = await pluginClient.getProjectPlugins();
        const projectEntry = projectPlugins.find(
          (p) => p.id === args.pluginId || p.dirName === args.pluginId
        );
        if (projectEntry) {
          return {
            pluginId: projectEntry.id,
            displayName: projectEntry.displayName,
            version: projectEntry.version,
            loaded: false,
            disabled: false,
            devMode: false,
            projectState: projectEntry.state,
            loadError: projectEntry.error
              ? { message: projectEntry.error, stack: null, at: null }
              : null,
            logLines: [],
            logLinesAvailable: 0,
          };
        }

        // Reported as manifest ids: an instance key names a project the caller
        // may not own, and is not a value they could pass back here anyway.
        const known = [
          ...snapshot.plugins.map(
            (p) => parseProjectPluginInstanceKey(p.pluginId)?.manifestId ?? p.pluginId
          ),
          ...projectPlugins.map((p) => p.id),
        ]
          .filter((id, index, all) => all.indexOf(id) === index)
          .sort();
        throw new Error(
          known.length > 0
            ? `No plugin "${args.pluginId}". Known ids: ${known.join(", ")}`
            : `No plugin "${args.pluginId}", and no plugins are loaded or discovered in this project.`
        );
      },
    })
  );

  actions.set("plugin.reloadProject", () =>
    defineAction({
      id: "plugin.reloadProject",
      title: "Reload project plugins",
      description:
        "Re-scan the open project's committed plugins and reconcile what is running against what is on disk, then report the state of every plugin directory found. This is how a newly written or rebuilt plugin is picked up without reopening the project. Trust and staging rules still apply, so an id the project has never run is listed but not executed.",
      category: "plugins",
      kind: "command",
      danger: "safe",
      // Reloading tears down and re-runs every project plugin, the caller
      // included. A plugin reaching this through `host.dispatch` would be
      // unloading itself mid-call, and no declared capability covers acting on
      // sibling plugins.
      denyPluginDispatch: true,
      scope: "renderer",
      resultSchema: z.object({
        plugins: z.array(
          z.object({
            id: z.string(),
            dirName: z.string(),
            displayName: z.string(),
            version: z.string(),
            state: z.enum(["active", "staged", "blocked", "invalid"]),
            error: z.string().nullable(),
            collidesWithGlobal: z.boolean(),
          })
        ),
      }),
      mcpOutputSchema: true,
      mcpAnnotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: false,
      },
      run: async () => {
        await pluginClient.reloadProjectPlugins();
        const plugins = await pluginClient.getProjectPlugins();
        return {
          plugins: plugins.map((p) => ({
            id: p.id,
            dirName: p.dirName,
            displayName: p.displayName,
            version: p.version,
            state: p.state,
            error: p.error ?? null,
            collidesWithGlobal: p.collidesWithGlobal,
          })),
        };
      },
    })
  );
}
