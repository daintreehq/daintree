import { describe, expect, it } from "vitest";
import {
  buildReportIssueUrl,
  buildReportIssueUrlForNotification,
  URL_BODY_BUDGET,
  type NotificationReportInput,
  type ReportIssueInput,
} from "../buildReportIssueUrl";

function getEncodedBodyLength(url: string): number {
  const bodyParam = new URL(url).searchParams.get("body") ?? "";
  return encodeURIComponent(bodyParam).length;
}

function makeInput(overrides: Partial<ReportIssueInput> = {}): ReportIssueInput {
  return {
    incidentId: "abc123",
    componentName: "TerminalPane",
    message: "boom",
    stack: "Error: boom\n  at thrower (file.ts:1)\n  at React.render (react.js:1)",
    componentStack: "  in TerminalPane\n  in PanelGrid",
    context: { worktreeId: "wt-1" },
    ...overrides,
  };
}

describe("buildReportIssueUrl", () => {
  it("includes all sections and stays under budget for short input", () => {
    const result = buildReportIssueUrl(makeInput());

    expect(result.usedClipboardFallback).toBe(false);
    expect(result.fullBody).toContain("**Component:** TerminalPane");
    expect(result.fullBody).toContain("**Incident ID:** abc123");
    expect(result.fullBody).toContain("**Message:** boom");
    expect(result.fullBody).toContain("Error: boom");
    expect(result.fullBody).toContain("in TerminalPane");
    expect(result.url).toContain("github.com/daintreehq/daintree/issues/new");
    expect(getEncodedBodyLength(result.url)).toBeLessThanOrEqual(URL_BODY_BUDGET);
  });

  it("encodes title and body so URL is safe to navigate", () => {
    const result = buildReportIssueUrl(
      makeInput({ message: "Cannot read property 'foo' of undefined & friends" })
    );
    const parsed = new URL(result.url);
    expect(parsed.searchParams.get("title")).toBe(
      "Component Error: Cannot read property 'foo' of undefined & friends"
    );
    expect(parsed.searchParams.get("body")).toContain("Cannot read property 'foo'");
  });

  it("falls back to placeholder values when fields are empty", () => {
    const result = buildReportIssueUrl({
      incidentId: null,
      componentName: undefined,
      message: "",
      stack: "",
      componentStack: "",
      context: undefined,
    });

    expect(result.fullBody).toContain("**Component:** Unknown");
    expect(result.fullBody).toContain("**Incident ID:** unknown");
    expect(result.fullBody).toContain("**Message:** Unknown error");
    expect(result.fullBody).toContain("No stack trace");
    expect(result.fullBody).toContain("No component stack");
    expect(result.usedClipboardFallback).toBe(false);
  });

  it("drops componentStack when full body exceeds budget", () => {
    // Component stack > budget on its own; error stack stays small.
    const longComponentStack = Array.from({ length: 800 }, (_, i) => `  in Comp${i}`).join("\n");
    const result = buildReportIssueUrl(makeInput({ componentStack: longComponentStack }));

    expect(result.usedClipboardFallback).toBe(false);
    expect(getEncodedBodyLength(result.url)).toBeLessThanOrEqual(URL_BODY_BUDGET);
    // The placeholder should sit where the stack used to be.
    expect(decodeURIComponent(new URL(result.url).searchParams.get("body") ?? "")).toContain(
      "component stack omitted"
    );
    // fullBody (clipboard payload) still has the original.
    expect(result.fullBody).toContain("in Comp0");
    expect(result.fullBody).toContain("in Comp799");
  });

  it("middle-truncates the error stack when componentStack omission isn't enough", () => {
    const longStack = Array.from({ length: 1500 }, (_, i) => `  at frame${i} (file.ts:${i})`).join(
      "\n"
    );
    const longComponentStack = Array.from({ length: 200 }, (_, i) => `  in Comp${i}`).join("\n");
    const result = buildReportIssueUrl(
      makeInput({ stack: longStack, componentStack: longComponentStack })
    );

    expect(getEncodedBodyLength(result.url)).toBeLessThanOrEqual(URL_BODY_BUDGET);
    const body = decodeURIComponent(new URL(result.url).searchParams.get("body") ?? "");
    expect(body).toContain("middle frames truncated");
    // First frames preserved.
    expect(body).toContain("at frame0 (file.ts:0)");
    // Last frames preserved.
    expect(body).toContain("at frame1499 (file.ts:1499)");
    // Middle frame dropped.
    expect(body).not.toContain("at frame750 (file.ts:750)");
    // fullBody (clipboard payload) still has everything.
    expect(result.fullBody).toContain("at frame750 (file.ts:750)");
    expect(result.usedClipboardFallback).toBe(false);
  });

  it("falls back to clipboard stub when even truncated body exceeds budget", () => {
    // Build a single error message + first/last frames that, even when
    // middle-truncated, still blow the budget. Use very long lines.
    const longLine = "x".repeat(1200);
    const stack = Array.from({ length: 25 }, () => longLine).join("\n");
    const componentStack = Array.from({ length: 10 }, () => longLine).join("\n");
    const result = buildReportIssueUrl(makeInput({ stack, componentStack }));

    expect(result.usedClipboardFallback).toBe(true);
    expect(getEncodedBodyLength(result.url)).toBeLessThanOrEqual(URL_BODY_BUDGET);

    const body = decodeURIComponent(new URL(result.url).searchParams.get("body") ?? "");
    expect(body).toContain("copied to your clipboard");
    expect(body).toContain("**Incident ID:** abc123");
    expect(body).toContain("**Message:** boom");
    // Stub URL should NOT contain the giant stack.
    expect(body).not.toContain(longLine);
    // Full payload preserved for clipboard write.
    expect(result.fullBody).toContain(longLine);
    expect(result.fullBody).toContain("**Component:** TerminalPane");
  });

  it("respects budget exactly at boundary", () => {
    // Construct input that lands just under the budget.
    const padding = "a".repeat(URL_BODY_BUDGET - 500); // ASCII chars are 1:1 in encodeURIComponent
    const result = buildReportIssueUrl(makeInput({ stack: padding }));
    expect(result.usedClipboardFallback).toBe(false);
    expect(getEncodedBodyLength(result.url)).toBeLessThanOrEqual(URL_BODY_BUDGET);
  });

  it("URL is parseable and points at the right repo", () => {
    const result = buildReportIssueUrl(makeInput());
    const url = new URL(result.url);
    expect(url.host).toBe("github.com");
    expect(url.pathname).toBe("/daintreehq/daintree/issues/new");
    expect(url.searchParams.has("title")).toBe(true);
    expect(url.searchParams.has("body")).toBe(true);
  });

  it("keeps total URL length under 8192 across every truncation stage", () => {
    // Each stage corresponds to a different input size class.
    const inputs = [
      makeInput(), // small — full body fits
      makeInput({
        // medium — componentStack omitted
        componentStack: Array.from({ length: 800 }, (_, i) => `  in Comp${i}`).join("\n"),
      }),
      makeInput({
        // large — stack middle-truncated
        stack: Array.from({ length: 1500 }, (_, i) => `  at frame${i} (file.ts:${i})`).join("\n"),
        componentStack: Array.from({ length: 200 }, (_, i) => `  in Comp${i}`).join("\n"),
      }),
      makeInput({
        // huge — clipboard fallback
        stack: Array.from({ length: 25 }, () => "x".repeat(1200)).join("\n"),
        componentStack: Array.from({ length: 10 }, () => "x".repeat(1200)).join("\n"),
      }),
    ];
    for (const input of inputs) {
      const result = buildReportIssueUrl(input);
      expect(result.url.length).toBeLessThanOrEqual(8192);
    }
  });

  it("caps title length when the error message is enormous", () => {
    // 700 emojis encode to 700×4 = 2800 bytes — well past the 8192 cap on
    // its own. The title cap keeps the URL safe.
    const result = buildReportIssueUrl(makeInput({ message: "😀".repeat(700) }));
    const title = new URL(result.url).searchParams.get("title") ?? "";
    expect(title.endsWith("…")).toBe(true);
    expect(result.url.length).toBeLessThanOrEqual(8192);
    // The full message should still appear in the body / clipboard payload.
    expect(result.fullBody).toContain("😀");
  });

  it("caps title for very long ASCII messages", () => {
    const longMessage = "A".repeat(5000);
    const result = buildReportIssueUrl(makeInput({ message: longMessage }));
    expect(result.url.length).toBeLessThanOrEqual(8192);
    const title = new URL(result.url).searchParams.get("title") ?? "";
    expect(title.length).toBeLessThan(longMessage.length);
    expect(title.endsWith("…")).toBe(true);
  });
});

function makeNotificationInput(
  overrides: Partial<NotificationReportInput> = {}
): NotificationReportInput {
  return {
    title: "Build failed",
    message: "Webpack compilation error",
    correlationId: "corr-42",
    context: { projectId: "proj-1", panelId: "panel-7" },
    appVersion: "0.42.0",
    electronVersion: "41.0.1",
    chromiumVersion: "146.0.7339.16",
    os: "MacIntel",
    ...overrides,
  };
}

describe("buildReportIssueUrlForNotification", () => {
  it("uses 'Notification:' prefix in the title and prefers entry title over message", () => {
    const result = buildReportIssueUrlForNotification(makeNotificationInput());
    const title = new URL(result.url).searchParams.get("title") ?? "";
    expect(title).toBe("Notification: Build failed");
  });

  it("falls back to the message when title is missing", () => {
    const result = buildReportIssueUrlForNotification(
      makeNotificationInput({ title: undefined, message: "Reconnection failed" })
    );
    const title = new URL(result.url).searchParams.get("title") ?? "";
    expect(title).toBe("Notification: Reconnection failed");
  });

  it("includes correlation id, context, and environment fields in the body", () => {
    const result = buildReportIssueUrlForNotification(makeNotificationInput());
    expect(result.fullBody).toContain("**Title:** Build failed");
    expect(result.fullBody).toContain("**Message:** Webpack compilation error");
    expect(result.fullBody).toContain("**Correlation ID:** corr-42");
    expect(result.fullBody).toContain('"projectId": "proj-1"');
    expect(result.fullBody).toContain("App version: 0.42.0");
    expect(result.fullBody).toContain("Electron: 41.0.1");
    expect(result.fullBody).toContain("Chromium: 146.0.7339.16");
    expect(result.fullBody).toContain("OS: MacIntel");
    expect(result.usedClipboardFallback).toBe(false);
  });

  it("renders placeholders when optional fields are missing", () => {
    const result = buildReportIssueUrlForNotification(
      makeNotificationInput({
        title: undefined,
        correlationId: undefined,
        context: undefined,
        appVersion: "",
        electronVersion: "",
        chromiumVersion: "",
        os: "",
      })
    );
    expect(result.fullBody).toContain("**Title:** (none)");
    expect(result.fullBody).toContain("**Correlation ID:** unknown");
    expect(result.fullBody).toContain("App version: unknown");
    expect(result.fullBody).toContain("Electron: unknown");
    expect(result.fullBody).toContain("Chromium: unknown");
    expect(result.fullBody).toContain("OS: unknown");
  });

  it("falls back to clipboard stub when message exceeds the URL budget", () => {
    const longMessage = "x".repeat(URL_BODY_BUDGET + 2000);
    const result = buildReportIssueUrlForNotification(
      makeNotificationInput({ message: longMessage })
    );
    expect(result.usedClipboardFallback).toBe(true);
    expect(getEncodedBodyLength(result.url)).toBeLessThanOrEqual(URL_BODY_BUDGET);
    const body = decodeURIComponent(new URL(result.url).searchParams.get("body") ?? "");
    expect(body).toContain("copied to your clipboard");
    expect(body).toContain("**Correlation ID:** corr-42");
    expect(body).not.toContain(longMessage);
    expect(result.fullBody).toContain(longMessage);
  });

  it("URL is parseable and points at the right repo", () => {
    const result = buildReportIssueUrlForNotification(makeNotificationInput());
    const url = new URL(result.url);
    expect(url.host).toBe("github.com");
    expect(url.pathname).toBe("/daintreehq/daintree/issues/new");
    expect(url.searchParams.has("title")).toBe(true);
    expect(url.searchParams.has("body")).toBe(true);
  });

  it("encoded body stays within the URL budget", () => {
    const result = buildReportIssueUrlForNotification(makeNotificationInput());
    expect(getEncodedBodyLength(result.url)).toBeLessThanOrEqual(URL_BODY_BUDGET);
  });

  it("caps the title for huge messages without truncating the body", () => {
    const result = buildReportIssueUrlForNotification(
      makeNotificationInput({ title: undefined, message: "A".repeat(5000) })
    );
    const title = new URL(result.url).searchParams.get("title") ?? "";
    expect(title.endsWith("…")).toBe(true);
    expect(result.url.length).toBeLessThanOrEqual(8192);
  });
});
