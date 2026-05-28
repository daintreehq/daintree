import {
  URL_BODY_BUDGET,
  capForBudget,
  makeUrl,
  truncateStackMiddle,
} from "@shared/utils/githubIssueUrl";
import { scrubReportText } from "@shared/utils/reportScrubbers";

import type { ActionBreadcrumb } from "../../../shared/types/ipc/crashRecovery";

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
  /** Override the "now" reference for relative timestamps (test-only). */
  now?: number;
}

export interface ReportIssueResult {
  url: string;
  fullBody: string;
  usedClipboardFallback: boolean;
}

export interface NotificationReportInput {
  title: string | undefined;
  message: string;
  correlationId: string | undefined;
  context: Record<string, unknown> | undefined;
  appVersion: string;
  electronVersion: string;
  chromiumVersion: string;
  os: string;
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

function formatBody(params: {
  componentName: string | undefined;
  incidentId: string | null;
  message: string;
  context: Record<string, unknown> | undefined;
  stack: string;
  componentStack: string;
  systemInfo?: string;
  recentActions?: ActionBreadcrumb[];
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
    formatRecentActionsSection(recentActions, now)
  );
}

// The stub body fits inside the URL, so the message line is capped just like
// the title — a multi-kilobyte message would otherwise blow the budget.
const STUB_MESSAGE_BUDGET = 1000;

function buildStubBody(params: {
  componentName: string | undefined;
  incidentId: string | null;
  message: string;
}): string {
  const { componentName, incidentId, message } = params;
  const cappedMessage = capForBudget(message || "Unknown error", STUB_MESSAGE_BUDGET);
  return (
    `## Error Report\n\n` +
    `The full error details were copied to your clipboard — please paste them below.\n\n` +
    `**Component:** ${componentName || "Unknown"}\n` +
    `**Incident ID:** ${incidentId ?? "unknown"}\n` +
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
 *   4. Drop recentActions section, keep systemInfo
 *   5. Drop systemInfo too
 *   6. Stub body + clipboard fallback
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
  });

  if (encodeURIComponent(withTruncatedStack).length <= URL_BODY_BUDGET) {
    return {
      url: makeUrl(title, withTruncatedStack),
      fullBody,
      usedClipboardFallback: false,
    };
  }

  // Drop recent actions first — the system info is more compact and more
  // useful for triage than a long action log when budget is tight.
  const withoutActions = formatBody({
    ...base,
    stack: truncatedStack,
    componentStack: COMPONENT_STACK_PLACEHOLDER,
    systemInfo: input.systemInfo,
    recentActions: undefined,
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
  });

  return { url: makeUrl(title, stubBody), fullBody, usedClipboardFallback: true };
}

function formatNotificationBody(params: {
  title: string | undefined;
  message: string;
  correlationId: string | undefined;
  context: Record<string, unknown> | undefined;
  appVersion: string;
  electronVersion: string;
  chromiumVersion: string;
  os: string;
}): string {
  const {
    title,
    message,
    correlationId,
    context,
    appVersion,
    electronVersion,
    chromiumVersion,
    os,
  } = params;
  return (
    `## Notification Report\n\n` +
    `**Title:** ${title || "(none)"}\n` +
    `**Message:** ${message || "(none)"}\n` +
    `**Correlation ID:** ${correlationId ?? "unknown"}\n\n` +
    `**Context:**\n` +
    `${context ? JSON.stringify(context, null, 2) : "None"}\n\n` +
    `**Environment:**\n` +
    `- App version: ${appVersion || "unknown"}\n` +
    `- Electron: ${electronVersion || "unknown"}\n` +
    `- Chromium: ${chromiumVersion || "unknown"}\n` +
    `- OS: ${os || "unknown"}\n`
  );
}

function buildNotificationStubBody(params: {
  title: string | undefined;
  message: string;
  correlationId: string | undefined;
  appVersion: string;
  electronVersion: string;
  chromiumVersion: string;
  os: string;
}): string {
  const { title, message, correlationId, appVersion, electronVersion, chromiumVersion, os } =
    params;
  const cappedMessage = capForBudget(message || "(none)", STUB_MESSAGE_BUDGET);
  return (
    `## Notification Report\n\n` +
    `The full notification details were copied to your clipboard — please paste them below.\n\n` +
    `**Title:** ${title || "(none)"}\n` +
    `**Message:** ${cappedMessage}\n` +
    `**Correlation ID:** ${correlationId ?? "unknown"}\n\n` +
    `**Environment:**\n` +
    `- App version: ${appVersion || "unknown"}\n` +
    `- Electron: ${electronVersion || "unknown"}\n` +
    `- Chromium: ${chromiumVersion || "unknown"}\n` +
    `- OS: ${os || "unknown"}\n`
  );
}

/**
 * Build the GitHub issue URL for a notification-inbox entry. Reuses the
 * same encoded-budget guard as `buildReportIssueUrl` and falls back to a
 * clipboard stub when the body can't fit. Notifications have no stack
 * trace, so the truncation pipeline is one-stage rather than three-stage.
 */
export function buildReportIssueUrlForNotification(
  input: NotificationReportInput
): ReportIssueResult {
  const titleSource = input.title || input.message || "Notification";
  const title = `Notification: ${titleSource}`;
  const fullBody = formatNotificationBody({
    title: input.title,
    message: input.message,
    correlationId: input.correlationId,
    context: input.context,
    appVersion: input.appVersion,
    electronVersion: input.electronVersion,
    chromiumVersion: input.chromiumVersion,
    os: input.os,
  });

  if (encodeURIComponent(fullBody).length <= URL_BODY_BUDGET) {
    return { url: makeUrl(title, fullBody), fullBody, usedClipboardFallback: false };
  }

  const stubBody = buildNotificationStubBody({
    title: input.title,
    message: input.message,
    correlationId: input.correlationId,
    appVersion: input.appVersion,
    electronVersion: input.electronVersion,
    chromiumVersion: input.chromiumVersion,
    os: input.os,
  });

  return { url: makeUrl(title, stubBody), fullBody, usedClipboardFallback: true };
}
