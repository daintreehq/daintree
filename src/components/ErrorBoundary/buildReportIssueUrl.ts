import type { PluginDiagnosticsSnapshot } from "../../../shared/types/plugin";

const REPO_ISSUE_URL = "https://github.com/daintreehq/daintree/issues/new";

// GitHub's Nginx fronts the issue form at an 8 KiB URL hard cap. Reserve
// ~1 KiB for base URL + title + percent-encoding fudge, leaving ~7 KB for
// the encoded body. Measured against `encodeURIComponent` because newlines
// and backticks inflate 1→3 bytes.
export const URL_BODY_BUDGET = 7000;

// Cap the encoded title separately so a multi-kilobyte error message can't
// blow the URL hard cap from the title side, even when the body fits.
const TITLE_ENCODED_BUDGET = 200;

// When the stack must be middle-truncated we keep the top frames (where the
// throw originates) and the tail (where it bubbled up through React). 15+5
// fits a typical render-error stack while leaving the truncation visible.
const STACK_HEAD_LINES = 15;
const STACK_TAIL_LINES = 5;

const COMPONENT_STACK_PLACEHOLDER =
  "<!-- component stack omitted — exceeded URL budget; full report copied to clipboard -->";
const STACK_MIDDLE_PLACEHOLDER =
  "  ... [middle frames truncated — see clipboard for full stack] ...";

export interface ReportIssueInput {
  incidentId: string | null;
  componentName: string | undefined;
  message: string;
  stack: string;
  componentStack: string;
  context: Record<string, unknown> | undefined;
  /**
   * Optional plugin diagnostics snapshot (loaded plugins, provenance, scrubbed
   * recent log lines). Rendered as a collapsible section appended to the body.
   * Supplementary context — dropped from the URL first when over budget, but
   * always present in `fullBody` for the clipboard fallback. Omitted entirely
   * when no plugins are loaded.
   */
  pluginDiagnostics?: PluginDiagnosticsSnapshot;
}

export interface ReportIssueResult {
  url: string;
  fullBody: string;
  usedClipboardFallback: boolean;
}

function formatBody(params: {
  componentName: string | undefined;
  incidentId: string | null;
  message: string;
  context: Record<string, unknown> | undefined;
  stack: string;
  componentStack: string;
}): string {
  const { componentName, incidentId, message, context, stack, componentStack } = params;
  return (
    `## Error Report\n\n` +
    `**Component:** ${componentName || "Unknown"}\n` +
    `**Incident ID:** ${incidentId ?? "unknown"}\n` +
    `**Message:** ${message || "Unknown error"}\n\n` +
    `**Context:**\n` +
    `${context ? JSON.stringify(context, null, 2) : "None"}\n\n` +
    `**Stack Trace:**\n\`\`\`\n${stack || "No stack trace"}\n\`\`\`\n\n` +
    `**Component Stack:**\n\`\`\`\n${componentStack || "No component stack"}\n\`\`\``
  );
}

/**
 * Render the plugin diagnostics slice as a collapsible markdown section so it
 * doesn't dominate a short report. Returns an empty string when no plugins are
 * loaded — the caller omits the section entirely.
 */
function formatPluginDiagnosticsSection(
  diagnostics: PluginDiagnosticsSnapshot | undefined
): string {
  if (!diagnostics || diagnostics.length === 0) return "";
  const lines: string[] = [];
  for (const plugin of diagnostics) {
    lines.push(`#### ${plugin.name}@${plugin.version} (${plugin.source})`);
    lines.push(`- Installed: ${plugin.installedAt}`);
    if (plugin.devMode) lines.push(`- Dev mode: yes`);
    if (plugin.loadError) {
      lines.push(`- Load error:`);
      lines.push("```");
      lines.push(plugin.loadError);
      lines.push("```");
    }
    if (plugin.logLines.length > 0) {
      lines.push(`- Recent logs (${plugin.logLines.length}, newest first):`);
      lines.push("```");
      for (const line of plugin.logLines) {
        const ts = new Date(line.timestamp).toISOString();
        const fields = line.fields ? ` ${line.fields}` : "";
        lines.push(`[${ts}] ${line.level.toUpperCase()} ${line.message}${fields}`);
      }
      lines.push("```");
    }
    if (plugin.actionAuditTail && plugin.actionAuditTail.length > 0) {
      lines.push(`- Recent actions:`);
      for (const entry of plugin.actionAuditTail) {
        const ts = new Date(entry.timestamp).toISOString();
        lines.push(`  - ${ts} \`${entry.actionId}\` (${entry.effectiveDanger})`);
      }
    }
    lines.push("");
  }
  return (
    `<details>\n<summary>Plugin diagnostics (${diagnostics.length})</summary>\n\n` +
    `${lines.join("\n")}\n</details>`
  );
}

function truncateStackMiddle(stack: string): string {
  const lines = stack.split("\n");
  if (lines.length <= STACK_HEAD_LINES + STACK_TAIL_LINES) return stack;
  const head = lines.slice(0, STACK_HEAD_LINES);
  const tail = lines.slice(-STACK_TAIL_LINES);
  return [...head, STACK_MIDDLE_PLACEHOLDER, ...tail].join("\n");
}

function capMessageForStub(message: string): string {
  // The stub body fits inside the URL, so we cap the message line just like
  // the title — a multi-kilobyte message would otherwise blow the budget.
  const STUB_MESSAGE_BUDGET = 1000;
  if (encodeURIComponent(message).length <= STUB_MESSAGE_BUDGET) return message;
  const ellipsis = "…";
  const ellipsisLen = encodeURIComponent(ellipsis).length;
  const chars = Array.from(message);
  while (chars.length > 0) {
    const trimmed = chars.join("");
    if (encodeURIComponent(trimmed).length + ellipsisLen <= STUB_MESSAGE_BUDGET) {
      return trimmed + ellipsis;
    }
    chars.pop();
  }
  return ellipsis;
}

function buildStubBody(params: {
  componentName: string | undefined;
  incidentId: string | null;
  message: string;
}): string {
  const { componentName, incidentId, message } = params;
  const cappedMessage = capMessageForStub(message || "Unknown error");
  return (
    `## Error Report\n\n` +
    `The full error details were copied to your clipboard — please paste them below.\n\n` +
    `**Component:** ${componentName || "Unknown"}\n` +
    `**Incident ID:** ${incidentId ?? "unknown"}\n` +
    `**Message:** ${cappedMessage}\n`
  );
}

function capTitle(title: string): string {
  if (encodeURIComponent(title).length <= TITLE_ENCODED_BUDGET) return title;
  // Trim character-by-character until the encoded form fits, leaving room
  // for the ellipsis. Walking by character avoids slicing into a multi-byte
  // surrogate pair.
  const ellipsis = "…";
  const ellipsisLen = encodeURIComponent(ellipsis).length;
  const chars = Array.from(title);
  while (chars.length > 0) {
    const trimmed = chars.join("");
    if (encodeURIComponent(trimmed).length + ellipsisLen <= TITLE_ENCODED_BUDGET) {
      return trimmed + ellipsis;
    }
    chars.pop();
  }
  return ellipsis;
}

function makeUrl(title: string, body: string): string {
  return `${REPO_ISSUE_URL}?title=${encodeURIComponent(capTitle(title))}&body=${encodeURIComponent(body)}`;
}

/**
 * Build the GitHub issue URL for a captured render error, applying a
 * staged truncation strategy so the encoded body always fits within the
 * URL budget. When even truncation isn't enough, the caller is told to
 * write `fullBody` to the clipboard and use the short stub URL.
 */
export function buildReportIssueUrl(input: ReportIssueInput): ReportIssueResult {
  const title = `Component Error: ${input.message || "Unknown"}`;
  const pluginSection = formatPluginDiagnosticsSection(input.pluginDiagnostics);
  const baseBody = formatBody({
    componentName: input.componentName,
    incidentId: input.incidentId,
    message: input.message,
    context: input.context,
    stack: input.stack,
    componentStack: input.componentStack,
  });
  // `fullBody` is the complete report (incl. plugin diagnostics) — it's what
  // the clipboard fallback writes. The URL body may carry less.
  const fullBody = pluginSection ? `${baseBody}\n\n${pluginSection}` : baseBody;

  // Prefer including plugin diagnostics in the URL when the whole thing fits.
  if (encodeURIComponent(fullBody).length <= URL_BODY_BUDGET) {
    return { url: makeUrl(title, fullBody), fullBody, usedClipboardFallback: false };
  }

  // Plugin diagnostics are supplementary — drop them from the URL before
  // touching the error signal, then run the existing truncation waterfall on
  // the error report alone. (When no plugins are loaded, baseBody === fullBody
  // and this is the original first check.)
  if (pluginSection && encodeURIComponent(baseBody).length <= URL_BODY_BUDGET) {
    return { url: makeUrl(title, baseBody), fullBody, usedClipboardFallback: false };
  }

  const withoutComponentStack = formatBody({
    componentName: input.componentName,
    incidentId: input.incidentId,
    message: input.message,
    context: input.context,
    stack: input.stack,
    componentStack: COMPONENT_STACK_PLACEHOLDER,
  });

  if (encodeURIComponent(withoutComponentStack).length <= URL_BODY_BUDGET) {
    return {
      url: makeUrl(title, withoutComponentStack),
      fullBody,
      usedClipboardFallback: false,
    };
  }

  const truncatedStack = truncateStackMiddle(input.stack);
  const withTruncatedStack = formatBody({
    componentName: input.componentName,
    incidentId: input.incidentId,
    message: input.message,
    context: input.context,
    stack: truncatedStack,
    componentStack: COMPONENT_STACK_PLACEHOLDER,
  });

  if (encodeURIComponent(withTruncatedStack).length <= URL_BODY_BUDGET) {
    return {
      url: makeUrl(title, withTruncatedStack),
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
