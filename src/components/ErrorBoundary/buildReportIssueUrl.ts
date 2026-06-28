import {
  URL_BODY_BUDGET,
  capForBudget,
  makeUrl,
  truncateStackMiddle,
} from "@shared/utils/githubIssueUrl";
import { scrubReportText } from "@shared/utils/reportScrubbers";

import type { ActionBreadcrumb } from "../../../shared/types/ipc/crashRecovery";
import type {
  PluginDiagnosticsAuditRecord,
  PluginDiagnosticsLogLine,
  PluginDiagnosticsSnapshot,
} from "../../../shared/types/ipc/pluginDiagnostics";

// Re-exported so existing importers (and tests) keep a stable surface; the
// canonical definition now lives in the shared helper.
export { URL_BODY_BUDGET };

const COMPONENT_STACK_PLACEHOLDER =
  "<!-- component stack omitted — exceeded URL budget; full report copied to clipboard -->";

// Single-character source markers keep each breadcrumb line short so 10
// entries fit comfortably in the URL budget.
const SOURCE_GLYPH: Record<string, string> = {
  user: "u",
  keybinding: "k",
  menu: "m",
  agent: "a",
  "context-menu": "c",
};

export interface ReportEnvInfo {
  appVersion: string;
  electron: string;
  chrome: string;
  os: string;
  /** Human-readable running architecture; surfaces Rosetta translation for triage. */
  arch?: string;
}

export interface ReportIssueInput {
  incidentId: string | null;
  componentName: string | undefined;
  message: string;
  stack: string;
  componentStack: string;
  context: Record<string, unknown> | undefined;
  /** Pre-formatted compact system snapshot (one fact per line). */
  systemInfo?: string;
  /** Recent action breadcrumbs (oldest first). */
  recentActions?: ActionBreadcrumb[];
  /** Loaded-plugin diagnostics (logger ring buffer + audit tail + provenance). */
  pluginDiagnostics?: PluginDiagnosticsSnapshot | null;
  /** Override the "now" reference for relative timestamps (test-only). */
  now?: number;
}

export interface ReportIssueResult {
  url: string;
  fullBody: string;
  usedClipboardFallback: boolean;
}

export interface NotificationReportInput {
  /** The notification's correlation ID — used in the issue body as the report identifier. */
  correlationId: string | null;
  /** The notification title/message text. Becomes the issue title suffix and body line. */
  message: string;
  /** Notification type (error / warning / info / success) for triage. */
  notificationType?: string;
  /** Extra metadata (project/worktree/panel/eventKind) attached to the entry. */
  context: Record<string, unknown> | undefined;
  /** Build/runtime environment info — required for inbox reports. */
  envInfo: ReportEnvInfo;
}

function formatRelativeAge(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return `-${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `-${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `-${hours}h`;
}

function formatBreadcrumbLine(entry: ActionBreadcrumb, now: number): string {
  const age = formatRelativeAge(entry.timestamp, now);
  const glyph = SOURCE_GLYPH[entry.source] ?? "?";
  // Escape pipe to keep the format unambiguous if action IDs ever pick one up.
  const actionId = entry.actionId.replace(/\|/g, "\\|");
  const parts = [age, actionId, `[${glyph}]`];
  if (entry.danger === "confirm" || entry.danger === "restricted") {
    parts.push(`!${entry.danger}`);
  }
  if (entry.count > 1) {
    parts.push(`x${entry.count}`);
  }
  return parts.join(" ");
}

function formatSystemInfoSection(systemInfo: string | undefined): string {
  if (!systemInfo) return "";
  // GFM requires a blank line after </summary> before inner Markdown renders.
  return (
    `\n\n<details>\n<summary>System info</summary>\n\n` +
    `\`\`\`\n${systemInfo}\n\`\`\`\n\n` +
    `</details>`
  );
}

function formatRecentActionsSection(actions: ActionBreadcrumb[] | undefined, now: number): string {
  if (!actions || actions.length === 0) return "";
  const lines = actions.map((entry) => formatBreadcrumbLine(entry, now));
  return (
    `\n\n<details>\n<summary>Recent actions (${actions.length})</summary>\n\n` +
    `\`\`\`\n${lines.join("\n")}\n\`\`\`\n\n` +
    `</details>`
  );
}

function formatPluginAuditLine(record: PluginDiagnosticsAuditRecord): string {
  const ts = new Date(record.ts).toISOString();
  const kind = record.recordType ?? "action-dispatch";
  const parts = [ts, kind, record.actionId, record.result, `${record.durationMs}ms`];
  if (record.errorMessage) parts.push(`— ${record.errorMessage}`);
  return parts.join(" ");
}

function formatPluginLogLine(line: PluginDiagnosticsLogLine): string {
  return `${new Date(line.ts).toISOString()} [${line.level}] ${line.message}`;
}

function formatPluginEntry(plugin: PluginDiagnosticsSnapshot["plugins"][number]): string {
  const tags = [
    plugin.isBuiltin ? "builtin" : null,
    plugin.devMode ? "dev" : null,
    plugin.disabled ? "disabled" : null,
  ].filter(Boolean);
  const tagSuffix = tags.length > 0 ? ` (${tags.join(", ")})` : "";
  const installed = plugin.installedAt ? new Date(plugin.installedAt).toISOString() : "n/a";

  const meta = [
    `### ${plugin.displayName} v${plugin.version}${tagSuffix}`,
    `- id: ${plugin.pluginId}`,
    `- source: ${plugin.source}`,
    `- installed: ${installed}`,
    `- archiveHash: ${plugin.archiveHash ?? "n/a"}`,
    `- loadError: ${plugin.loadError ? plugin.loadError.message : "none"}`,
  ].join("\n");

  const auditBlock =
    plugin.auditRecords.length > 0
      ? `\n\naudit (${plugin.auditRecords.length}):\n\`\`\`\n` +
        `${plugin.auditRecords.map(formatPluginAuditLine).join("\n")}\n\`\`\``
      : "";

  const logBlock =
    plugin.logLines.length > 0
      ? `\n\nlogs (${plugin.logLines.length}):\n\`\`\`\n` +
        `${plugin.logLines.map(formatPluginLogLine).join("\n")}\n\`\`\``
      : "";

  return meta + auditBlock + logBlock;
}

function formatPluginDiagnosticsSection(
  snapshot: PluginDiagnosticsSnapshot | null | undefined
): string {
  if (!snapshot || snapshot.plugins.length === 0) return "";
  const body = snapshot.plugins.map(formatPluginEntry).join("\n\n");
  // Scrub the whole block once — log lines and loadError messages can carry
  // user paths or secret sigils. scrubReportText only rewrites those, never
  // the surrounding Markdown structure.
  const scrubbed = scrubReportText(body);
  return (
    `\n\n<details>\n<summary>Plugin diagnostics (${snapshot.plugins.length})</summary>\n\n` +
    `${scrubbed}\n\n` +
    `</details>`
  );
}

function formatBody(params: {
  componentName: string | undefined;
  incidentId: string | null;
  message: string;
  context: Record<string, unknown> | undefined;
  stack: string;
  componentStack: string;
  systemInfo?: string;
  recentActions?: ActionBreadcrumb[];
  pluginDiagnostics?: PluginDiagnosticsSnapshot | null;
  now: number;
}): string {
  const {
    componentName,
    incidentId,
    message,
    context,
    stack,
    componentStack,
    systemInfo,
    recentActions,
    pluginDiagnostics,
    now,
  } = params;
  return (
    `## Error Report\n\n` +
    `**Component:** ${componentName || "Unknown"}\n` +
    `**Incident ID:** ${incidentId ?? "unknown"}\n` +
    `**Message:** ${message || "Unknown error"}\n\n` +
    `**Context:**\n` +
    `${context ? JSON.stringify(context, null, 2) : "None"}\n\n` +
    `**Stack Trace:**\n\`\`\`\n${stack || "No stack trace"}\n\`\`\`\n\n` +
    `**Component Stack:**\n\`\`\`\n${componentStack || "No component stack"}\n\`\`\`` +
    formatSystemInfoSection(systemInfo) +
    formatRecentActionsSection(recentActions, now) +
    formatPluginDiagnosticsSection(pluginDiagnostics)
  );
}

function formatEnvBlock(envInfo: ReportEnvInfo | undefined): string {
  if (!envInfo) return "";
  return (
    `## Environment\n\n` +
    "```yaml\n" +
    `app: ${envInfo.appVersion || "unknown"}\n` +
    `electron: ${envInfo.electron || "unknown"}\n` +
    `chrome: ${envInfo.chrome || "unknown"}\n` +
    `os: ${envInfo.os || "unknown"}\n` +
    (envInfo.arch ? `arch: ${envInfo.arch}\n` : "") +
    "```\n\n"
  );
}

/**
 * Notification-report body: omits stack/component-stack sections (notifications
 * are not thrown exceptions), keeps the environment block, and gates the
 * `**Context:**` section behind a non-empty payload so single-line reports
 * don't carry an "**Context:** None" footer that adds no signal.
 */
function formatNotificationBody(params: {
  incidentId: string | null;
  message: string;
  context: Record<string, unknown> | undefined;
  envInfo: ReportEnvInfo | undefined;
  notificationType?: string;
}): string {
  const { incidentId, message, context, envInfo, notificationType } = params;
  const contextBlock =
    context && Object.keys(context).length > 0
      ? `**Context:**\n${JSON.stringify(context, null, 2)}\n\n`
      : "";
  const typeLine = notificationType ? `**Type:** ${notificationType}\n` : "";
  return (
    `## Notification Report\n\n` +
    `**Correlation ID:** ${incidentId ?? "unknown"}\n` +
    typeLine +
    `**Message:** ${message || "Unknown notification"}\n\n` +
    formatEnvBlock(envInfo) +
    contextBlock
  ).trimEnd();
}

// The stub body fits inside the URL, so the message line is capped just like
// the title — a multi-kilobyte message would otherwise blow the budget.
const STUB_MESSAGE_BUDGET = 1000;

function buildStubBody(params: {
  componentName: string | undefined;
  incidentId: string | null;
  message: string;
  pluginCount: number;
}): string {
  const { componentName, incidentId, message, pluginCount } = params;
  const cappedMessage = capForBudget(message || "Unknown error", STUB_MESSAGE_BUDGET);
  const pluginLine =
    pluginCount > 0
      ? `\n_${pluginCount} plugin${pluginCount === 1 ? "" : "s"} loaded — full diagnostics in the clipboard payload._\n`
      : "";
  return (
    `## Error Report\n\n` +
    `The full error details were copied to your clipboard — please paste them below.\n\n` +
    `**Component:** ${componentName || "Unknown"}\n` +
    `**Incident ID:** ${incidentId ?? "unknown"}\n` +
    `**Message:** ${cappedMessage}\n` +
    pluginLine
  );
}

function buildNotificationStubBody(params: { incidentId: string | null; message: string }): string {
  const { incidentId, message } = params;
  const cappedMessage = capForBudget(message || "Unknown notification", STUB_MESSAGE_BUDGET);
  return (
    `## Notification Report\n\n` +
    `The full notification details were copied to your clipboard — please paste them below.\n\n` +
    `**Correlation ID:** ${incidentId ?? "unknown"}\n` +
    `**Message:** ${cappedMessage}\n`
  );
}

/**
 * Build the GitHub issue URL for a captured render error, applying a
 * staged truncation strategy so the encoded body always fits within the
 * URL budget. When even truncation isn't enough, the caller is told to
 * write `fullBody` to the clipboard and use the short stub URL.
 *
 * Truncation ladder (highest fidelity first):
 *   1. Full body + enrichment sections fit → use it
 *   2. Drop componentStack, keep enrichment
 *   3. Middle-truncate stack, keep enrichment
 *   4. Drop plugin diagnostics (the largest section), keep systemInfo + actions
 *   5. Drop recentActions section, keep systemInfo
 *   6. Drop systemInfo too
 *   7. Stub body + clipboard fallback
 */
export function buildReportIssueUrl(input: ReportIssueInput): ReportIssueResult {
  // Redact user paths/secrets before the stack enters either the URL body or
  // the clipboard payload — both surfaces end up pasted into a public issue.
  const stack = scrubReportText(input.stack);
  const componentStack = scrubReportText(input.componentStack);

  const title = `Component Error: ${input.message || "Unknown"}`;
  const now = input.now ?? Date.now();
  const base = {
    componentName: input.componentName,
    incidentId: input.incidentId,
    message: input.message,
    context: input.context,
    now,
  };

  const fullBody = formatBody({
    ...base,
    stack,
    componentStack,
    systemInfo: input.systemInfo,
    recentActions: input.recentActions,
    pluginDiagnostics: input.pluginDiagnostics,
  });

  if (encodeURIComponent(fullBody).length <= URL_BODY_BUDGET) {
    return { url: makeUrl(title, fullBody), fullBody, usedClipboardFallback: false };
  }

  const withoutComponentStack = formatBody({
    ...base,
    stack,
    componentStack: COMPONENT_STACK_PLACEHOLDER,
    systemInfo: input.systemInfo,
    recentActions: input.recentActions,
    pluginDiagnostics: input.pluginDiagnostics,
  });

  if (encodeURIComponent(withoutComponentStack).length <= URL_BODY_BUDGET) {
    return {
      url: makeUrl(title, withoutComponentStack),
      fullBody,
      usedClipboardFallback: false,
    };
  }

  const truncatedStack = truncateStackMiddle(stack);
  const withTruncatedStack = formatBody({
    ...base,
    stack: truncatedStack,
    componentStack: COMPONENT_STACK_PLACEHOLDER,
    systemInfo: input.systemInfo,
    recentActions: input.recentActions,
    pluginDiagnostics: input.pluginDiagnostics,
  });

  if (encodeURIComponent(withTruncatedStack).length <= URL_BODY_BUDGET) {
    return {
      url: makeUrl(title, withTruncatedStack),
      fullBody,
      usedClipboardFallback: false,
    };
  }

  // Drop plugin diagnostics next — it's the largest enrichment section (a
  // 500-line log buffer per plugin), and the full payload is preserved on the
  // clipboard regardless. systemInfo + recent actions stay in the URL.
  const withoutPluginDiagnostics = formatBody({
    ...base,
    stack: truncatedStack,
    componentStack: COMPONENT_STACK_PLACEHOLDER,
    systemInfo: input.systemInfo,
    recentActions: input.recentActions,
    pluginDiagnostics: undefined,
  });

  if (encodeURIComponent(withoutPluginDiagnostics).length <= URL_BODY_BUDGET) {
    return {
      url: makeUrl(title, withoutPluginDiagnostics),
      fullBody,
      usedClipboardFallback: false,
    };
  }

  // Drop recent actions next — the system info is more compact and more
  // useful for triage than a long action log when budget is tight.
  const withoutActions = formatBody({
    ...base,
    stack: truncatedStack,
    componentStack: COMPONENT_STACK_PLACEHOLDER,
    systemInfo: input.systemInfo,
    recentActions: undefined,
    pluginDiagnostics: undefined,
  });

  if (encodeURIComponent(withoutActions).length <= URL_BODY_BUDGET) {
    return {
      url: makeUrl(title, withoutActions),
      fullBody,
      usedClipboardFallback: false,
    };
  }

  const withoutEnrichment = formatBody({
    ...base,
    stack: truncatedStack,
    componentStack: COMPONENT_STACK_PLACEHOLDER,
    systemInfo: undefined,
    recentActions: undefined,
  });

  if (encodeURIComponent(withoutEnrichment).length <= URL_BODY_BUDGET) {
    return {
      url: makeUrl(title, withoutEnrichment),
      fullBody,
      usedClipboardFallback: false,
    };
  }

  const stubBody = buildStubBody({
    componentName: input.componentName,
    incidentId: input.incidentId,
    message: input.message,
    pluginCount: input.pluginDiagnostics?.plugins.length ?? 0,
  });

  return { url: makeUrl(title, stubBody), fullBody, usedClipboardFallback: true };
}

/**
 * Build the GitHub issue URL for a notification-inbox report. Reuses the
 * staged URL-budget / clipboard-fallback pipeline from the crash path but
 * formats a notification-shaped body (no stack/component stack, environment
 * block populated, context block gated on a non-empty payload). The title
 * prefix is `"Notification Report"`.
 */
export function buildNotificationReportUrl(input: NotificationReportInput): ReportIssueResult {
  const title = `Notification Report: ${input.message || "Unknown"}`;
  const fullBody = formatNotificationBody({
    incidentId: input.correlationId,
    message: input.message,
    context: input.context,
    envInfo: input.envInfo,
    notificationType: input.notificationType,
  });

  if (encodeURIComponent(fullBody).length <= URL_BODY_BUDGET) {
    return { url: makeUrl(title, fullBody), fullBody, usedClipboardFallback: false };
  }

  const stubBody = buildNotificationStubBody({
    incidentId: input.correlationId,
    message: input.message,
  });

  return { url: makeUrl(title, stubBody), fullBody, usedClipboardFallback: true };
}
