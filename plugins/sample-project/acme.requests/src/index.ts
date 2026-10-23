import type {
  PluginArtifact,
  PluginHostApi,
  PluginMcpToolDefinition,
} from "@daintreehq/plugin-sdk";
import { createOperationManager, type OperationSnapshot } from "@daintreehq/plugin-sdk/operations";
import {
  CHANNELS,
  EVENTS,
  MAX_NOTES_CHARS,
  MAX_TITLE_CHARS,
  REQUEST_STATUSES,
  type ConnectionStatus,
  type ReportSummary,
  type UpdateRequestArgs,
} from "./contracts";
import { syntheticReportKind, type ReportInput, type ReportResult } from "./provider";
import { createStoreOpener, isRequestStatus, RequestInputError } from "./store";

/** The `contributes.agentMcp` endpoint the tools below are served on. */
const ENDPOINT_ID = "requests";
const WORKSPACE_SETTING = "providerWorkspace";

/**
 * Request Desk's worker. Everything durable lives here rather than in a view:
 * the store, the report operations and the artifact handles. Views come and go
 * (switching Home to Grid unmounts one) and only ask the worker for data.
 *
 * Nothing here spells the plugin's own name. Qualified ids are built from
 * `host.pluginInfo.manifestId`, so the scaffold can copy this build under any
 * name without rebuilding it.
 */
export async function activate(host: PluginHostApi): Promise<() => void> {
  const { manifestId, projectRoot } = host.pluginInfo;
  const disposers: Array<() => void> = [];
  let disposed = false;

  const push = (channel: string) => {
    if (!disposed) void host.postToPanel(channel, null).catch(() => {});
  };

  const openStore = createStoreOpener(host, (store) => {
    // Fires for our own commits and for an agent writing the file with sqlite3.
    disposers.push(store.db.onDidChange(() => push(EVENTS.requestsChanged)));
  });

  const workspace = async (): Promise<string | null> => {
    const value = await host.settings.get<string>(WORKSPACE_SETTING);
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };

  const writeReport = async (reportId: string, svg: string): Promise<string> => {
    if (!projectRoot) throw new Error("Request Desk runs only inside its project.");
    const dir = `${projectRoot}/.daintree/data/${manifestId}/reports`;
    await host.fs.mkdir(dir);
    const path = `${dir}/${reportId}.svg`;
    await host.fs.writeFile(path, svg);
    return path;
  };

  const operations = createOperationManager(
    {
      tasks: host.tasks,
      // The manager has no change feed of its own. Watching the journal it
      // opens tells the views when a report moved, with no polling in them.
      db: {
        open: async (id, options) => {
          const handle = await host.db.open(id, options);
          disposers.push(handle.onDidChange(() => push(EVENTS.reportsChanged)));
          return handle;
        },
      },
    },
    {
      database: "operations",
      retryActionId: `${manifestId}.resume-report`,
      kinds: { report: syntheticReportKind({ openStore, workspace, writeReport }) },
    }
  );

  // Artifacts live for the session only. The report file is the durable
  // thing; the artifact is re-imported from it whenever its handle is gone.
  const artifactIds = new Map<string, string>();
  const reportArtifact = async (reportId: string): Promise<PluginArtifact | null> => {
    const known = artifactIds.get(reportId);
    if (known) {
      const live = await host.artifacts.stat(known);
      if (live) return live;
      artifactIds.delete(reportId);
    }
    const store = await openStore();
    const row = (await store.db.get("SELECT path FROM reports WHERE id = ?", [reportId])) as
      { path: string } | undefined;
    if (!row) return null;
    const artifact = await host.artifacts.import(
      { path: row.path },
      { name: `${reportId}.svg`, mimeType: "image/svg+xml" }
    );
    artifactIds.set(reportId, artifact.id);
    return artifact;
  };

  const summarize = (op: OperationSnapshot): ReportSummary => {
    const result = op.result as ReportResult | undefined;
    return {
      operationId: op.id,
      state: op.state,
      reportId: result?.reportId ?? null,
      requestCount: result?.requestCount ?? null,
      fraction: op.progress?.fraction ?? null,
      error: op.error?.message ?? null,
      createdAt: op.createdAt,
    };
  };

  const startReport = async (requestedBy: ReportInput["requestedBy"], key?: string) => {
    const op = await operations.submit<ReportResult>(
      "report",
      { requestedBy } satisfies ReportInput,
      {
        // The same key twice returns the same operation, so a double click or an
        // agent retrying a timed-out call never starts a second build.
        idempotencyKey: key ?? `report:${requestedBy}:${crypto.randomUUID()}`,
      }
    );
    push(EVENTS.reportsChanged);
    return summarize(op);
  };

  const resumeReport = async (operationId: unknown): Promise<ReportSummary | null> => {
    if (typeof operationId !== "string") return null;
    const op = await operations.retry(operationId);
    push(EVENTS.reportsChanged);
    return op ? summarize(op) : null;
  };

  const connection = async (): Promise<ConnectionStatus> => {
    const ws = await workspace();
    return { connected: ws !== null, workspace: ws };
  };

  // --- View channels -------------------------------------------------------

  await host.registerHandler(CHANNELS.list, async (_ctx, args) => {
    const { status } = (args ?? {}) as { status?: unknown };
    return (await openStore()).list({ status: isRequestStatus(status) ? status : undefined });
  });
  await host.registerHandler(CHANNELS.get, async (_ctx, args) => {
    const { id } = (args ?? {}) as { id?: unknown };
    return typeof id === "string" ? (await openStore()).get(id) : null;
  });
  await host.registerHandler(CHANNELS.add, async (_ctx, args) => {
    const { title, notes } = (args ?? {}) as { title?: unknown; notes?: unknown };
    return (await openStore()).add({ title, notes });
  });
  await host.registerHandler(CHANNELS.update, async (_ctx, args) =>
    (await openStore()).update(args as UpdateRequestArgs)
  );
  await host.registerHandler(CHANNELS.reports, async () =>
    (await operations.list({ limit: 20 })).map(summarize)
  );
  await host.registerHandler(CHANNELS.startReport, async (_ctx, args) => {
    const { key } = (args ?? {}) as { key?: unknown };
    return startReport("view", typeof key === "string" ? key : undefined);
  });
  await host.registerHandler(CHANNELS.retryReport, async (_ctx, args) =>
    resumeReport((args as { operationId?: unknown } | undefined)?.operationId)
  );
  await host.registerHandler(CHANNELS.reportArtifact, async (_ctx, args) => {
    const { reportId } = (args ?? {}) as { reportId?: unknown };
    return typeof reportId === "string" ? reportArtifact(reportId) : null;
  });
  await host.registerHandler(CHANNELS.connection, connection);
  await host.registerHandler(CHANNELS.connect, async (_ctx, args) => {
    const { workspace: name } = (args ?? {}) as { workspace?: unknown };
    const value =
      typeof name === "string" && name.trim() ? name.trim().slice(0, 64) : "Demo workspace";
    await host.settings.set(WORKSPACE_SETTING, value);
    return connection();
  });
  await host.registerHandler(CHANNELS.testConnection, async () => {
    const ws = await workspace();
    return ws
      ? { ok: true, message: `Reached ${ws}. The synthetic provider answers offline.` }
      : { ok: false, message: "Not connected. Connect a workspace first." };
  });
  await host.registerHandler(CHANNELS.disconnect, async () => {
    await host.settings.unset(WORKSPACE_SETTING);
    return connection();
  });

  disposers.push(
    await host.settings.onDidChange(WORKSPACE_SETTING, () => push(EVENTS.connectionChanged))
  );

  // --- Agent tools ---------------------------------------------------------

  const tools: Record<string, PluginMcpToolDefinition> = {
    list_requests: {
      description:
        "List this project's Request Desk requests, most recently changed first. Each has an id, title, status, notes and a revision to pass to update_request.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: [...REQUEST_STATUSES] },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
        additionalProperties: false,
      },
      async execute(args) {
        const status = isRequestStatus(args.status) ? args.status : undefined;
        const limit = typeof args.limit === "number" ? args.limit : undefined;
        return { requests: await (await openStore()).list({ status, limit }) };
      },
    },
    add_request: {
      description:
        "Add a request. Pass the same id again to retry a call that timed out: it returns the request already made instead of a duplicate.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: MAX_TITLE_CHARS },
          notes: { type: "string", maxLength: MAX_NOTES_CHARS },
          id: { type: "string", pattern: "^[a-z0-9-]{1,64}$" },
        },
        required: ["title"],
        additionalProperties: false,
      },
      async execute(args) {
        const id = typeof args.id === "string" ? args.id : undefined;
        return {
          request: await (await openStore()).add({ title: args.title, notes: args.notes, id }),
        };
      },
    },
    update_request: {
      description:
        "Change a request's title, status or notes. Pass the revision you last read; if someone changed it since, nothing is written and the current request comes back so you can decide again.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", maxLength: 64 },
          revision: { type: "integer", minimum: 1 },
          title: { type: "string", minLength: 1, maxLength: MAX_TITLE_CHARS },
          status: { type: "string", enum: [...REQUEST_STATUSES] },
          notes: { type: "string", maxLength: MAX_NOTES_CHARS },
        },
        required: ["id", "revision"],
        additionalProperties: false,
      },
      async execute(args) {
        try {
          return await (await openStore()).update(args as unknown as UpdateRequestArgs);
        } catch (error) {
          if (error instanceof RequestInputError) return { ok: false, reason: error.message };
          throw error;
        }
      },
    },
    generate_report: {
      description:
        "Start building a report of every request. Returns at once with an operationId; the report builds in the background, so call get_report with it until state is succeeded or failed.",
      inputSchema: {
        type: "object",
        properties: { key: { type: "string", maxLength: 128 } },
        additionalProperties: false,
      },
      async execute(args) {
        const key = typeof args.key === "string" ? `agent:${args.key}` : undefined;
        return startReport("agent", key);
      },
    },
    get_report: {
      description: "Read the state of a report started with generate_report.",
      inputSchema: {
        type: "object",
        properties: { operationId: { type: "string", maxLength: 128 } },
        required: ["operationId"],
        additionalProperties: false,
      },
      async execute(args) {
        const op = await operations.get(String(args.operationId));
        return op ? summarize(op) : { state: "unknown", operationId: args.operationId };
      },
    },
  };
  disposers.push(await host.mcp.registerTools(ENDPOINT_ID, tools));

  // --- Commands ------------------------------------------------------------

  await host.registerAction(
    {
      id: "first-request",
      title: "Try Request Desk with an agent",
      description: "Choose an agent and put a first Request Desk task in its draft.",
      category: "Request Desk",
      kind: "command",
      danger: "safe",
    },
    async () => {
      // Drafted, never sent: the user reads it, adds to it and presses Enter.
      const result = await host.sendToAgent(
        [
          "Use the Request Desk tools (list_requests, add_request, update_request) for this project.",
          "1. List the open requests.",
          '2. Add a request titled "Write the onboarding checklist".',
          "3. Move the oldest open request to in_progress, with a one-line note on what you'd do first.",
          "Request Desk's list updates as each tool call lands.",
        ].join("\n"),
        { title: "Try Request Desk" }
      );
      if (result.status === "refused") {
        await host.showToast({
          message: `The task couldn't be drafted (${result.reason}).`,
          type: "warning",
        });
      }
      return result;
    }
  );

  await host.registerAction(
    {
      id: "open-connection",
      title: "Connect the report provider",
      description: "Open the Request Desk connection page in Project settings.",
      category: "Request Desk",
      kind: "command",
      danger: "safe",
    },
    async () =>
      host.dispatch("plugin.openSettings", {
        pluginId: manifestId,
        section: "custom",
        page: "connection",
      })
  );

  await host.registerAction(
    {
      id: "resume-report",
      title: "Resume report",
      description: "Pick up a report the provider may still be building.",
      category: "Request Desk",
      kind: "command",
      danger: "safe",
    },
    async (args) => resumeReport((args as { operationId?: unknown } | undefined)?.operationId)
  );

  // Picks up any report a restart interrupted, whether or not a view is open.
  await operations.start();

  return () => {
    disposed = true;
    for (const dispose of disposers.splice(0)) dispose();
    void operations.dispose().catch(() => {});
  };
}
