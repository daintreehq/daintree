import {
  URL_BODY_BUDGET,
  capForBudget,
  makeUrl,
  truncateStackMiddle,
} from "@shared/utils/githubIssueUrl";
import { scrubReportText } from "@shared/utils/reportScrubbers";

// Re-exported so existing importers (and tests) keep a stable surface; the
// canonical definition now lives in the shared helper.
export { URL_BODY_BUDGET };

const COMPONENT_STACK_PLACEHOLDER =
  "<!-- component stack omitted — exceeded URL budget; full report copied to clipboard -->";

export interface ReportIssueInput {
  incidentId: string | null;
  componentName: string | undefined;
  message: string;
  stack: string;
  componentStack: string;
  context: Record<string, unknown> | undefined;
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
 */
export function buildReportIssueUrl(input: ReportIssueInput): ReportIssueResult {
  // Redact user paths/secrets before the stack enters either the URL body or
  // the clipboard payload — both surfaces end up pasted into a public issue.
  const stack = scrubReportText(input.stack);
  const componentStack = scrubReportText(input.componentStack);

  const title = `Component Error: ${input.message || "Unknown"}`;
  const fullBody = formatBody({
    componentName: input.componentName,
    incidentId: input.incidentId,
    message: input.message,
    context: input.context,
    stack,
    componentStack,
  });

  if (encodeURIComponent(fullBody).length <= URL_BODY_BUDGET) {
    return { url: makeUrl(title, fullBody), fullBody, usedClipboardFallback: false };
  }

  const withoutComponentStack = formatBody({
    componentName: input.componentName,
    incidentId: input.incidentId,
    message: input.message,
    context: input.context,
    stack,
    componentStack: COMPONENT_STACK_PLACEHOLDER,
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
