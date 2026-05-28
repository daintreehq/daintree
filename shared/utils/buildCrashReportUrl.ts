import type { ActionBreadcrumb, CrashLogEntry } from "../types/ipc/crashRecovery.js";
import { scrubReportText } from "./reportScrubbers.js";
import { URL_BODY_BUDGET, capForBudget, makeUrl, truncateStackMiddle } from "./githubIssueUrl.js";

export interface CrashReportResult {
  url: string;
  fullBody: string;
  usedClipboardFallback: boolean;
}

function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function formatBytesCompact(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  let i = Math.floor(Math.log(bytes) / Math.log(k));
  i = Math.max(0, Math.min(i, sizes.length - 1));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function stringifyArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args);
  } catch {
    return "[unserializable]";
  }
}

// `new Date(bad).toISOString()` throws RangeError on a non-numeric/NaN timestamp.
// A corrupt persisted crash log shouldn't crash the report builder (or the dialog
// that computes the report in a render-time useMemo), so fall back to the raw value.
function safeIsoTime(ts: number): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toISOString();
}

/**
 * Render the recent-action trail as a markdown table. Args are JSON-stringified
 * and run through `scrubReportText` so user paths and secrets in argument values
 * never reach the report. Entries are chronological (oldest first) so the table
 * reads as the lead-up to the crash. Returns an empty string when there are no
 * actions.
 */
export function formatRecentActions(actions: ActionBreadcrumb[] | undefined): string {
  if (!actions || actions.length === 0) return "";
  const rows = actions.map((a) => {
    const time = safeIsoTime(a.timestamp);
    const danger = a.danger === "safe" ? "" : a.danger;
    const confirmed = a.confirmed ? "yes" : "";
    const count = a.count > 1 ? `×${a.count}` : "";
    const argsStr =
      a.args && Object.keys(a.args).length > 0 ? scrubReportText(stringifyArgs(a.args)) : "";
    // Pipes inside cell content would break the markdown table layout.
    const safeArgs = argsStr.replace(/\|/g, "\\|").replace(/\n/g, " ");
    return `| ${time} | \`${a.actionId}\` | ${a.source} | ${danger} | ${formatDuration(a.durationMs)} | ${count} | ${confirmed} | ${safeArgs} |`;
  });
  return [
    `**Recent actions (${actions.length}):**`,
    ``,
    `| Time | Action | Source | Danger | Duration | Count | Confirmed | Args |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- |`,
    ...rows,
  ].join("\n");
}

function formatCrashBody(
  entry: CrashLogEntry,
  options: { includeActions: boolean; stack: string | undefined }
): string {
  const e = entry;
  const lines: string[] = [
    `## Crash Report`,
    ``,
    `**Daintree ${e.appVersion}** on ${e.platform} ${e.arch}`,
    `- **OS**: ${e.osVersion}`,
  ];

  const versionParts: string[] = [];
  if (e.electronVersion) versionParts.push(`**Electron**: ${e.electronVersion}`);
  if (e.nodeVersion) versionParts.push(`**Node**: ${e.nodeVersion}`);
  if (e.chromeVersion) versionParts.push(`**Chrome**: ${e.chromeVersion}`);
  if (versionParts.length > 0) lines.push(`- ${versionParts.join(" | ")}`);

  const sessionParts: string[] = [];
  if (e.sessionDurationMs !== undefined)
    sessionParts.push(`**Session**: ${formatDuration(e.sessionDurationMs)}`);
  if (e.isPackaged !== undefined) sessionParts.push(`**Packaged**: ${e.isPackaged ? "Yes" : "No"}`);
  if (sessionParts.length > 0) lines.push(`- ${sessionParts.join(" | ")}`);

  if (e.totalMemory !== undefined) {
    lines.push(
      `- **Memory (Free/Total)**: ${formatBytesCompact(e.freeMemory ?? 0)} / ${formatBytesCompact(e.totalMemory)}`
    );
  }
  if (e.rss !== undefined || e.heapUsed !== undefined) {
    const parts: string[] = [];
    if (e.rss !== undefined) parts.push(`RSS ${formatBytesCompact(e.rss)}`);
    if (e.heapUsed !== undefined && e.heapTotal !== undefined)
      parts.push(`Heap ${formatBytesCompact(e.heapUsed)}/${formatBytesCompact(e.heapTotal)}`);
    lines.push(`- **Process Memory**: ${parts.join(", ")}`);
  }

  const infoParts: string[] = [];
  if (e.panelCount !== undefined) {
    let panelStr = String(e.panelCount);
    if (e.panelKinds && Object.keys(e.panelKinds).length > 0) {
      panelStr += ` (${Object.entries(e.panelKinds)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ")})`;
    }
    infoParts.push(`**Panels**: ${panelStr}`);
  }
  if (e.windowCount !== undefined) infoParts.push(`**Windows**: ${e.windowCount}`);
  if (infoParts.length > 0) lines.push(`- ${infoParts.join(" | ")}`);

  if (e.cpuCount !== undefined) lines.push(`- **CPUs**: ${e.cpuCount}`);
  if (e.gpuAccelerationDisabled !== undefined)
    lines.push(`- **GPU Acceleration**: ${e.gpuAccelerationDisabled ? "Disabled" : "Enabled"}`);

  lines.push(`- **Crashed at**: ${new Date(e.timestamp).toISOString()}`);

  if (e.cause === "watchdog-deadlock") {
    const causeParts: string[] = [`**Cause**: Watchdog deadlock (SIGKILL)`];
    if (e.watchdogMissedBeats !== undefined) {
      causeParts.push(`${e.watchdogMissedBeats} missed heartbeats`);
    }
    if (e.watchdogKilledAt !== undefined) {
      causeParts.push(`killed at ${new Date(e.watchdogKilledAt).toISOString()}`);
    }
    if (e.watchdogMainPid !== undefined) {
      causeParts.push(`main PID ${e.watchdogMainPid}`);
    }
    lines.push(`- ${causeParts.join(" — ")}`);
  }

  if (e.errorMessage) {
    lines.push(``, `**Error:** ${e.errorMessage}`);
  }
  if (options.stack) {
    lines.push(
      ``,
      `<details>`,
      `<summary>Stack trace</summary>`,
      ``,
      "```",
      options.stack,
      "```",
      ``,
      `</details>`
    );
  }

  if (options.includeActions) {
    const actionsBlock = formatRecentActions(e.recentActions);
    if (actionsBlock) {
      lines.push(``, actionsBlock);
    }
  }

  // Scrub the whole body at the report boundary so user paths/secrets in any
  // field (error message, stack, action args) are redacted before sharing.
  return scrubReportText(lines.join("\n"));
}

function buildStubBody(entry: CrashLogEntry): string {
  const message = entry.errorMessage || "Daintree closed unexpectedly";
  return scrubReportText(
    `## Crash Report\n\n` +
      `The full crash details were copied to your clipboard — please paste them below.\n\n` +
      `**Daintree ${entry.appVersion}** on ${entry.platform} ${entry.arch}\n` +
      `**Error:** ${capForBudget(message, 1000)}\n`
  );
}

function makeCrashTitle(entry: CrashLogEntry): string {
  // Scrub the title too — it carries the error message, which can contain user
  // paths or secrets that would otherwise leak in the URL's `title=` param.
  return scrubReportText(
    `Crash: ${entry.errorMessage || entry.cause || "Daintree closed unexpectedly"}`
  );
}

/**
 * Build the GitHub issue URL for a captured crash, applying a staged truncation
 * strategy so the encoded body always fits within the URL budget:
 *   1. Full body (env + error + stack + recent actions).
 *   2. Drop the recent-actions trail.
 *   3. Middle-truncate the stack trace.
 *   4. Stub body (header + message) + clipboard fallback.
 *
 * `fullBody` always contains the complete, redacted report regardless of which
 * stage was reached — when `usedClipboardFallback` is true the caller should
 * write `fullBody` to the clipboard so the user can paste the untruncated report.
 */
export function buildCrashReportUrl(entry: CrashLogEntry): CrashReportResult {
  const title = makeCrashTitle(entry);
  const fullBody = formatCrashBody(entry, { includeActions: true, stack: entry.errorStack });

  if (encodeURIComponent(fullBody).length <= URL_BODY_BUDGET) {
    return { url: makeUrl(title, fullBody), fullBody, usedClipboardFallback: false };
  }

  const withoutActions = formatCrashBody(entry, { includeActions: false, stack: entry.errorStack });
  if (encodeURIComponent(withoutActions).length <= URL_BODY_BUDGET) {
    return { url: makeUrl(title, withoutActions), fullBody, usedClipboardFallback: false };
  }

  const truncatedStack = entry.errorStack ? truncateStackMiddle(entry.errorStack) : undefined;
  const withTruncatedStack = formatCrashBody(entry, {
    includeActions: false,
    stack: truncatedStack,
  });
  if (encodeURIComponent(withTruncatedStack).length <= URL_BODY_BUDGET) {
    return { url: makeUrl(title, withTruncatedStack), fullBody, usedClipboardFallback: false };
  }

  return { url: makeUrl(title, buildStubBody(entry)), fullBody, usedClipboardFallback: true };
}

/**
 * Build the GitHub issue URL from an explicit (user-edited) report body. The
 * preview lets the user trim or redact further before submitting, so the URL is
 * rebuilt from whatever they leave in the textarea. If the edited body still
 * exceeds the URL budget, it falls back to the clipboard + stub URL.
 *
 * `fullBody` echoes the edited body so the caller copies exactly what the user
 * sees when the fallback fires.
 */
export function buildCrashReportUrlFromBody(entry: CrashLogEntry, body: string): CrashReportResult {
  const title = makeCrashTitle(entry);
  if (encodeURIComponent(body).length <= URL_BODY_BUDGET) {
    return { url: makeUrl(title, body), fullBody: body, usedClipboardFallback: false };
  }
  return { url: makeUrl(title, buildStubBody(entry)), fullBody: body, usedClipboardFallback: true };
}
