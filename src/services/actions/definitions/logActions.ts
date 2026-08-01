import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { z } from "zod";
import { errorsClient, eventInspectorClient, logsClient, telemetryPreviewClient } from "@/clients";
import { withPagination, PaginatedResultSchema, decodeIndexCursor } from "./schemas";
import { useErrorStore } from "@/store/errorStore";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import { useEventStore } from "@/store/eventStore";
import { useLogsStore } from "@/store/logsStore";
import { useDiagnosticsStore } from "@/store/diagnosticsStore";
import { useTelemetryPreviewStore } from "@/store/telemetryPreviewStore";

export function registerLogActions(actions: ActionRegistry, _callbacks: ActionCallbacks): void {
  actions.set("logs.openFile", () => ({
    id: "logs.openFile",
    title: "Open Logs File",
    description: "Open the logs file in the system file manager",
    category: "logs",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      await logsClient.openFile();
    },
  }));

  actions.set("logs.getAll", () => ({
    id: "logs.getAll",
    title: "Get Logs",
    description: "Get buffered application logs",
    category: "logs",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ filters: z.any().optional() }).optional(),
    resultSchema: z.object({ entries: z.array(z.unknown()) }),
    run: async (args: unknown) => {
      const { filters } = (args as { filters?: unknown } | undefined) ?? {};
      const result = await logsClient.getAll(filters as any);
      return { entries: result };
    },
  }));

  actions.set("logs.getSources", () => ({
    id: "logs.getSources",
    title: "Get Log Sources",
    description: "Get distinct log sources",
    category: "logs",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    resultSchema: z.object({ sources: z.array(z.string()) }),
    run: async () => {
      const result = await logsClient.getSources();
      return { sources: result };
    },
  }));

  actions.set("logs.clear", () => ({
    id: "logs.clear",
    title: "Clear Logs",
    description: "Clear application logs",
    category: "logs",
    kind: "command",
    danger: "confirm",
    // danger:"confirm" with the confirm wired at the call sites (Troubleshooting
    // settings, Diagnostics dock), NOT in run() — run() clears immediately.
    // ActionService doesn't gate user-source dispatch, so a palette pick would
    // bypass the D1 confirm. Hide from the palette; both buttons stay reachable.
    palette: { mode: "hidden" },
    scope: "renderer",
    dangerRationale:
      "Empties the log view and the in-memory buffer that diagnostic reports are built from. Doesn't delete the log file on disk.",
    run: async () => {
      // Buffer first: clearing the renderer store up front would leave the view
      // wiped even when the IPC rejects, so a failed clear could still cost the
      // logs it reported keeping.
      await logsClient.clear();
      useLogsStore.getState().clearLogs();
    },
  }));

  actions.set("logs.setVerbose", () => ({
    id: "logs.setVerbose",
    title: "Set Verbose Logging",
    description: "Enable or disable verbose logging",
    category: "logs",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ enabled: z.boolean() }),
    resultSchema: z.object({ success: z.boolean() }),
    run: async (args: unknown) => {
      const { enabled } = args as { enabled: boolean };
      // `logsClient.setVerbose` resolves void, so returning it directly gave
      // `undefined` where the declared shape promises `{ success }`. Reaching
      // this line means the call resolved; a rejection throws past it.
      await logsClient.setVerbose(enabled);
      return { success: true };
    },
  }));

  actions.set("logs.getVerbose", () => ({
    id: "logs.getVerbose",
    title: "Get Verbose Logging",
    description: "Get whether verbose logging is enabled",
    category: "logs",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    resultSchema: z.object({ verbose: z.boolean() }),
    run: async () => {
      const result = await logsClient.getVerbose();
      return { verbose: result };
    },
  }));

  actions.set("logs.setLogLevel", () => ({
    id: "logs.setLogLevel",
    title: "Set Log Level…",
    description: "Open the log level picker to adjust verbosity for a specific module",
    category: "logs",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      window.dispatchEvent(new CustomEvent("daintree:open-log-level-palette"));
    },
  }));

  actions.set("logs.getLevelOverrides", () => ({
    id: "logs.getLevelOverrides",
    title: "Get Log Level Overrides",
    description: "Return the current map of per-module log level overrides",
    category: "logs",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    resultSchema: z.record(z.string(), z.string()),
    run: async () => {
      return await logsClient.getLevelOverrides();
    },
  }));

  actions.set("logs.setLevelOverrides", () => ({
    id: "logs.setLevelOverrides",
    title: "Set Log Level Overrides",
    description: "Replace the full map of per-module log level overrides",
    category: "logs",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ overrides: z.record(z.string(), z.string()) }),
    resultSchema: z.object({ success: z.boolean() }),
    run: async (args: unknown) => {
      const { overrides } = args as { overrides: Record<string, string> };
      return await logsClient.setLevelOverrides(overrides);
    },
  }));

  actions.set("logs.clearLevelOverrides", () => ({
    id: "logs.clearLevelOverrides",
    title: "Clear Log Level Overrides",
    description: "Remove all per-module log level overrides",
    category: "logs",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    resultSchema: z.object({ success: z.boolean() }),
    run: async () => {
      return await logsClient.clearLevelOverrides();
    },
  }));

  actions.set("logs.getRegistry", () => ({
    id: "logs.getRegistry",
    title: "Get Logger Registry",
    description: "Return the list of loggers registered in the main process",
    category: "logs",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    resultSchema: z.object({ sources: z.array(z.string()) }),
    run: async () => {
      const result = await logsClient.getRegistry();
      return { sources: result };
    },
  }));

  actions.set("errors.openLogs", () => ({
    id: "errors.openLogs",
    title: "Open Error Logs",
    description: "Open the error log file",
    category: "errors",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      await errorsClient.openLogs();
    },
  }));

  actions.set("errors.clearAll", () => ({
    id: "errors.clearAll",
    title: "Clear All Errors",
    description: "Clear all error banners and problem entries",
    category: "errors",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      useErrorStore.getState().reset();
    },
  }));

  actions.set("errors.recent", () => ({
    id: "errors.recent",
    title: "Recent Errors",
    description:
      "List recent entries from the diagnostics error log, covering runtime and inter-process failures, newest first. This is a separate store from the user's notification inbox, so a full picture usually means reading both. It never fails; an empty list means nothing was recorded rather than that logging is off.",
    category: "errors",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z
      .object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(20)
          .optional()
          .describe("Max errors to return (default: 20, max: 50)"),
        includesDismissed: z
          .boolean()
          .default(false)
          .optional()
          .describe("Include dismissed errors (default: false — active errors only)"),
      })
      .optional(),
    resultSchema: z.object({ errors: z.array(z.unknown()) }),
    run: async (args: unknown) => {
      const { limit = 20, includesDismissed = false } =
        (args as { limit?: number; includesDismissed?: boolean } | undefined) ?? {};
      const errors = useErrorStore.getState().errors;
      const filtered = includesDismissed ? errors : errors.filter((e) => !e.dismissed);
      // errorStore dedup updates in place (keeps array slot, refreshes timestamp),
      // so array order is not strictly newest-first — sort before slicing.
      const sorted = [...filtered].sort((a, b) => b.timestamp - a.timestamp);
      return {
        errors: sorted.slice(0, limit).map((e) => ({
          id: e.id,
          type: e.type,
          message: e.message,
          details: e.details,
          source: e.source,
          timestamp: e.timestamp,
          retryability: e.retryability,
          dismissed: e.dismissed,
          worktreeId: e.context?.worktreeId,
          terminalId: e.context?.terminalId,
          recoveryHint: e.recoveryHint,
          retryExhausted: e.retryExhausted,
          occurrenceCount: e.occurrenceCount,
        })),
      };
    },
  }));

  actions.set("notifications.recent", () => ({
    id: "notifications.recent",
    title: "Recent Notifications",
    description:
      "List recent entries from the notification inbox — the completion, waiting and informational messages the user actually saw — newest first. This is a separate store from the diagnostics error log, so a full picture of what went wrong usually means reading both. It never fails; an empty list means nothing was notified.",
    category: "diagnostics",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z
      .object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(20)
          .optional()
          .describe("Max notifications to return (default: 20, max: 50)"),
        type: z
          .enum(["success", "error", "info", "warning"])
          .optional()
          .describe("Filter by notification type"),
        unreadOnly: z
          .boolean()
          .default(false)
          .optional()
          .describe("Only return notifications not yet seen as a toast (default: false)"),
      })
      .optional(),
    resultSchema: z.object({ notifications: z.array(z.unknown()) }),
    run: async (args: unknown) => {
      const {
        limit = 20,
        type,
        unreadOnly = false,
      } = (args as { limit?: number; type?: string; unreadOnly?: boolean } | undefined) ?? {};
      const entries = useNotificationHistoryStore.getState().entries;
      const filtered = entries.filter(
        (e) =>
          (!type || e.type === type) &&
          // Mirror the bell-badge unread definition (notificationHistorySlice
          // counts !seenAsToast && countable !== false) so `unreadOnly` doesn't
          // surface silent non-countable entries the UI never badges.
          (!unreadOnly || (!e.seenAsToast && e.countable !== false))
      );
      return {
        notifications: filtered.slice(0, limit).map((e) => ({
          id: e.id,
          type: e.type,
          title: e.title,
          message: typeof e.message === "string" ? e.message : "[rich content]",
          timestamp: e.timestamp,
          seenAsToast: e.seenAsToast,
          worktreeId: e.context?.worktreeId,
          panelId: e.context?.panelId,
          eventKind: e.context?.eventKind,
        })),
      };
    },
  }));

  actions.set("eventInspector.getEvents", () => ({
    id: "eventInspector.getEvents",
    title: "Get Events",
    description:
      "Get captured events from the event inspector. Args (all optional): `limit` (default 50, max 500); `offset` (default 0, `skip` is accepted as a legacy alias); `cursor` — pass the previous response's `nextCursor`. Returns { items, hasMore, nextCursor, total }.",
    category: "diagnostics",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: withPagination({}, { legacy: ["skip"], cursor: true, maxLimit: 500 }).optional(),
    resultSchema: PaginatedResultSchema(z.unknown()),
    run: async (args: unknown) => {
      const {
        limit = 50,
        offset,
        cursor,
      } = (args as { limit?: number; offset?: number; cursor?: string } | undefined) ?? {};
      // This source pages by index over an in-memory array, so its cursor IS
      // the next offset; an explicit `offset`/`skip` still wins.
      const start = offset ?? decodeIndexCursor(cursor) ?? 0;
      const allEvents = await eventInspectorClient.getEvents();
      const events = Array.isArray(allEvents) ? allEvents : [];
      const total = events.length;
      const items = events.slice(start, start + limit);
      const hasMore = start + limit < total;
      return { items, hasMore, nextCursor: hasMore ? String(start + items.length) : null, total };
    },
  }));

  actions.set("eventInspector.getFiltered", () => ({
    id: "eventInspector.getFiltered",
    title: "Get Filtered Events",
    description:
      "Get filtered events from the event inspector. Events must be subscribed to first via eventInspector_subscribe.",
    category: "diagnostics",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      category: z
        .enum(["system", "agent", "server", "file", "ui", "watcher", "artifact"])
        .optional()
        .describe("Filter by event category"),
      categories: z
        .array(z.enum(["system", "agent", "server", "file", "ui", "watcher", "artifact"]))
        .optional()
        .describe("Filter by multiple categories"),
      types: z.array(z.string()).optional().describe("Filter by event type strings"),
      worktreeId: z.string().optional().describe("Filter by worktree ID"),
      terminalId: z.string().optional().describe("Filter by terminal ID"),
      search: z.string().optional().describe("Search text in event data"),
      after: z.number().optional().describe("Only events after this timestamp (ms)"),
      before: z.number().optional().describe("Only events before this timestamp (ms)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Max events to return (default: 50, max: 500)"),
      offset: z.number().int().min(0).optional().describe("Number of events to skip (default: 0)"),
    }),
    resultSchema: z.object({
      events: z.array(z.unknown()),
      total: z.number(),
      limit: z.number(),
      offset: z.number(),
      hasMore: z.boolean(),
    }),
    run: async (args: unknown) => {
      const { limit, offset, ...filters } = args as Record<string, unknown>;
      const allEvents = await eventInspectorClient.getFiltered(filters as any);
      const events = Array.isArray(allEvents) ? allEvents : [];
      const effectiveLimit = typeof limit === "number" ? Math.min(Math.max(limit, 1), 500) : 50;
      const effectiveOffset = typeof offset === "number" ? Math.max(offset, 0) : 0;
      const total = events.length;
      const sliced = events.slice(effectiveOffset, effectiveOffset + effectiveLimit);
      return {
        events: sliced,
        total,
        limit: effectiveLimit,
        offset: effectiveOffset,
        hasMore: effectiveOffset + effectiveLimit < total,
      };
    },
  }));

  actions.set("eventInspector.subscribe", () => ({
    id: "eventInspector.subscribe",
    // Diagnostics/MCP plumbing: starts event capture with no visible effect.
    // Driven by the event-inspector UI and MCP, not a user palette command.
    palette: { mode: "hidden" },
    title: "Subscribe to Events",
    description:
      "Start capturing events into the event inspector. Must be called before getEvents or getFiltered will return results.",
    category: "diagnostics",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      eventInspectorClient.subscribe();
    },
  }));

  actions.set("eventInspector.unsubscribe", () => ({
    id: "eventInspector.unsubscribe",
    title: "Unsubscribe from Events",
    description: "Stop streaming events into the event inspector",
    category: "diagnostics",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      eventInspectorClient.unsubscribe();
    },
  }));

  actions.set("eventInspector.clear", () => ({
    id: "eventInspector.clear",
    title: "Clear Event Inspector",
    description: "Clear captured events in the event inspector",
    category: "diagnostics",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      useEventStore.getState().clearEvents();
      await eventInspectorClient.clear();
    },
  }));

  actions.set("telemetry.togglePreview", () => ({
    id: "telemetry.togglePreview",
    palette: { mode: "hidden" },
    title: "Preview Outbound Telemetry",
    description:
      "Toggle a session-only preview that mirrors every sanitised telemetry payload before it is sent.",
    category: "diagnostics",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ active: z.boolean().optional() }).optional(),
    run: async (args: unknown) => {
      const { active } = (args as { active?: boolean } | undefined) ?? {};
      const current = useTelemetryPreviewStore.getState().active;
      const next = typeof active === "boolean" ? active : !current;
      const result = await telemetryPreviewClient.toggle(next);
      useTelemetryPreviewStore.getState().setActive(result.active);
      if (result.active) {
        useDiagnosticsStore.getState().openDock("telemetry");
      }
      return result;
    },
  }));

  actions.set("telemetry.clearPreview", () => ({
    id: "telemetry.clearPreview",
    title: "Clear Telemetry Preview",
    description: "Clear captured telemetry preview events from the diagnostics dock.",
    category: "diagnostics",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      useTelemetryPreviewStore.getState().clearEvents();
    },
  }));

  actions.set("ui.refresh", () => ({
    id: "ui.refresh",
    title: "Reload Application",
    description: "Reload the renderer (useful for recovery)",
    category: "ui",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      window.location.reload();
    },
  }));

  actions.set("ui.sidebar.resetWidth", () => ({
    id: "ui.sidebar.resetWidth",
    title: "Reset Sidebar Width",
    description: "Reset the sidebar width to default",
    category: "ui",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      window.dispatchEvent(new CustomEvent("daintree:reset-sidebar-width"));
    },
  }));
}
