import { describe, expect, it } from "vitest";
import {
  buildNotificationReportUrl,
  buildReportIssueUrl,
  URL_BODY_BUDGET,
  type NotificationReportInput,
  type ReportEnvInfo,
  type ReportIssueInput,
} from "../buildReportIssueUrl";
import type { ActionBreadcrumb } from "../../../../shared/types/ipc/crashRecovery";
import type { PluginDiagnosticsSnapshot } from "../../../../shared/types/ipc/pluginDiagnostics";

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

  it("scrubs user paths from the stack in both URL body and clipboard payload", () => {
    const result = buildReportIssueUrl(
      makeInput({
        stack: "Error: boom\n  at fn (/Users/alice/project/file.ts:10)",
        componentStack: "  in Comp (/home/bob/app/Comp.tsx:3)",
      })
    );

    const body = decodeURIComponent(new URL(result.url).searchParams.get("body") ?? "");
    expect(body).toContain("/Users/USER/project/file.ts");
    expect(body).not.toContain("/Users/alice/");
    expect(body).toContain("/home/USER/app/Comp.tsx");
    expect(body).not.toContain("/home/bob/");

    // The clipboard payload is the same surface (pasted into a public issue).
    expect(result.fullBody).toContain("/Users/USER/project/file.ts");
    expect(result.fullBody).not.toContain("/Users/alice/");
    expect(result.fullBody).toContain("/home/USER/app/Comp.tsx");
    expect(result.fullBody).not.toContain("/home/bob/");
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

  describe("enrichment sections", () => {
    const fixedNow = 1_700_000_000_000;

    function makeBreadcrumb(overrides: Partial<ActionBreadcrumb> = {}): ActionBreadcrumb {
      return {
        id: "bc-1",
        actionId: "terminal.spawn",
        category: "terminal",
        source: "user",
        danger: "safe",
        durationMs: 5,
        timestamp: fixedNow - 12_000,
        count: 1,
        ...overrides,
      };
    }

    it("renders system info and recent actions as <details> sections", () => {
      const systemInfo = "App: 1.0.0 | Electron: 41.0.0 | Node: 22.0.0\nOS: darwin 24 arm64";
      const recentActions = [
        makeBreadcrumb(),
        makeBreadcrumb({
          id: "bc-2",
          actionId: "git.commit",
          source: "keybinding",
          timestamp: fixedNow - 4_000,
        }),
      ];
      const result = buildReportIssueUrl(makeInput({ systemInfo, recentActions, now: fixedNow }));

      expect(result.usedClipboardFallback).toBe(false);
      const body = decodeURIComponent(new URL(result.url).searchParams.get("body") ?? "");
      // GFM requires a blank line after </summary> for inner markdown to render.
      expect(body).toContain("<details>\n<summary>System info</summary>\n\n");
      expect(body).toContain("App: 1.0.0 | Electron: 41.0.0");
      expect(body).toContain("<details>\n<summary>Recent actions (2)</summary>\n\n");
      expect(body).toContain("-12s terminal.spawn [u]");
      expect(body).toContain("-4s git.commit [k]");
      expect(getEncodedBodyLength(result.url)).toBeLessThanOrEqual(URL_BODY_BUDGET);
    });

    it("omits the system info section when no value is provided", () => {
      const result = buildReportIssueUrl(makeInput({ now: fixedNow }));
      expect(result.fullBody).not.toContain("<summary>System info</summary>");
    });

    it("omits the recent actions section when the array is empty", () => {
      const result = buildReportIssueUrl(makeInput({ recentActions: [], now: fixedNow }));
      expect(result.fullBody).not.toContain("Recent actions");
    });

    it("marks danger and count on breadcrumb lines", () => {
      const recentActions = [
        makeBreadcrumb({
          actionId: "worktree.delete",
          danger: "confirm",
          count: 3,
          timestamp: fixedNow - 30_000,
        }),
      ];
      const result = buildReportIssueUrl(makeInput({ recentActions, now: fixedNow }));
      const body = decodeURIComponent(new URL(result.url).searchParams.get("body") ?? "");
      expect(body).toContain("-30s worktree.delete [u] !confirm x3");
    });

    it("formats minute-scale ages when older than 60 seconds", () => {
      const recentActions = [makeBreadcrumb({ timestamp: fixedNow - 125_000 })];
      const result = buildReportIssueUrl(makeInput({ recentActions, now: fixedNow }));
      const body = decodeURIComponent(new URL(result.url).searchParams.get("body") ?? "");
      expect(body).toContain("-2m terminal.spawn");
    });

    it("drops the recent actions section before the system info when budget is tight", () => {
      // Stack is big enough to force componentStack to drop and stack to be
      // middle-truncated; actions list is big enough that even after stack
      // truncation it doesn't fit, but dropping actions alone does.
      const longStack = Array.from(
        { length: 1500 },
        (_, i) => `  at frame${i} (file.ts:${i})`
      ).join("\n");
      const recentActions = Array.from({ length: 120 }, (_, i) =>
        makeBreadcrumb({
          id: `bc-${i}`,
          actionId: `category.long_action_id_with_extra_padding_number_${i}_zzz`,
          timestamp: fixedNow - i * 1000,
        })
      );
      const systemInfo = "App: 1.0.0 | Electron: 41.0.0";
      const result = buildReportIssueUrl(
        makeInput({ stack: longStack, recentActions, systemInfo, now: fixedNow })
      );
      const body = decodeURIComponent(new URL(result.url).searchParams.get("body") ?? "");
      expect(getEncodedBodyLength(result.url)).toBeLessThanOrEqual(URL_BODY_BUDGET);
      expect(body).toContain("<summary>System info</summary>");
      expect(body).not.toContain("Recent actions");
      expect(result.usedClipboardFallback).toBe(false);
    });

    it("drops the system info section when even dropping actions is not enough", () => {
      // Stack + huge systemInfo combine to overflow even after actions are
      // dropped, forcing systemInfo to drop too.
      const longStack = Array.from(
        { length: 1500 },
        (_, i) => `  at frame${i} (file.ts:${i})`
      ).join("\n");
      const systemInfo = "X".repeat(6000);
      const recentActions = Array.from({ length: 10 }, () => makeBreadcrumb());
      const result = buildReportIssueUrl(
        makeInput({ stack: longStack, recentActions, systemInfo, now: fixedNow })
      );
      const body = decodeURIComponent(new URL(result.url).searchParams.get("body") ?? "");
      expect(getEncodedBodyLength(result.url)).toBeLessThanOrEqual(URL_BODY_BUDGET);
      expect(body).not.toContain("<summary>System info</summary>");
      expect(body).not.toContain("Recent actions");
      expect(result.usedClipboardFallback).toBe(false);
    });

    it("falls back to clipboard stub if even unenriched body overflows", () => {
      const longLine = "x".repeat(1200);
      const stack = Array.from({ length: 25 }, () => longLine).join("\n");
      const componentStack = Array.from({ length: 10 }, () => longLine).join("\n");
      const systemInfo = "App: 1.0.0";
      const recentActions = [makeBreadcrumb()];
      const result = buildReportIssueUrl(
        makeInput({ stack, componentStack, systemInfo, recentActions, now: fixedNow })
      );
      expect(result.usedClipboardFallback).toBe(true);
      expect(getEncodedBodyLength(result.url)).toBeLessThanOrEqual(URL_BODY_BUDGET);
    });

    it("escapes pipe characters in action IDs to keep the line format unambiguous", () => {
      const recentActions = [
        makeBreadcrumb({ actionId: "weird|action", timestamp: fixedNow - 1000 }),
      ];
      const result = buildReportIssueUrl(makeInput({ recentActions, now: fixedNow }));
      const body = decodeURIComponent(new URL(result.url).searchParams.get("body") ?? "");
      expect(body).toContain("-1s weird\\|action [u]");
    });
  });
});

function makeNotificationInput(
  overrides: Partial<NotificationReportInput> = {}
): NotificationReportInput {
  return {
    correlationId: "notif-corr-1",
    message: "Token refresh failed",
    notificationType: "error",
    context: { projectId: "proj-1", panelId: "pane-7" },
    envInfo: {
      appVersion: "1.2.3",
      electron: "41.0.0",
      chrome: "146.0.0.0",
      os: "darwin 24.0.0 (arm64)",
    } satisfies ReportEnvInfo,
    ...overrides,
  };
}

describe("buildNotificationReportUrl", () => {
  it("uses the Notification Report header and omits stack sections", () => {
    const result = buildNotificationReportUrl(makeNotificationInput());
    expect(result.usedClipboardFallback).toBe(false);
    expect(result.fullBody).toContain("## Notification Report");
    expect(result.fullBody).toContain("**Correlation ID:** notif-corr-1");
    expect(result.fullBody).toContain("**Type:** error");
    expect(result.fullBody).toContain("**Message:** Token refresh failed");
    expect(result.fullBody).not.toContain("## Error Report");
    expect(result.fullBody).not.toContain("**Stack Trace:**");
    expect(result.fullBody).not.toContain("**Component Stack:**");
  });

  it("includes the Environment block populated from envInfo", () => {
    const result = buildNotificationReportUrl(makeNotificationInput());
    expect(result.fullBody).toContain("## Environment");
    expect(result.fullBody).toContain("app: 1.2.3");
    expect(result.fullBody).toContain("electron: 41.0.0");
  });

  it("emits an arch line in the Environment block when arch is present", () => {
    const result = buildNotificationReportUrl(
      makeNotificationInput({
        envInfo: {
          appVersion: "1.2.3",
          electron: "41.0.0",
          chrome: "146.0.0.0",
          os: "darwin 24.0.0 (arm64)",
          arch: "Intel (Rosetta)",
        } satisfies ReportEnvInfo,
      })
    );
    expect(result.fullBody).toContain("arch: Intel (Rosetta)");
  });

  it("omits the arch line when arch is absent", () => {
    // The default envInfo has no arch field; the block must not emit a bare
    // "arch:" line that reads as an empty/unknown value.
    const result = buildNotificationReportUrl(makeNotificationInput());
    expect(result.fullBody).not.toContain("arch:");
  });

  it("titles the issue with the Notification Report prefix", () => {
    const result = buildNotificationReportUrl(makeNotificationInput());
    const title = new URL(result.url).searchParams.get("title") ?? "";
    expect(title).toBe("Notification Report: Token refresh failed");
  });

  it("renders the Context block only when context has keys", () => {
    const withContext = buildNotificationReportUrl(makeNotificationInput());
    expect(withContext.fullBody).toContain("**Context:**");
    expect(withContext.fullBody).toContain('"projectId": "proj-1"');

    const withoutContext = buildNotificationReportUrl(
      makeNotificationInput({ context: undefined })
    );
    expect(withoutContext.fullBody).not.toContain("**Context:**");

    const emptyContext = buildNotificationReportUrl(makeNotificationInput({ context: {} }));
    expect(emptyContext.fullBody).not.toContain("**Context:**");
  });

  it("falls back to clipboard stub when the notification body blows the URL budget", () => {
    const longMessage = "x".repeat(URL_BODY_BUDGET + 500);
    const result = buildNotificationReportUrl(makeNotificationInput({ message: longMessage }));
    expect(result.usedClipboardFallback).toBe(true);
    const body = decodeURIComponent(new URL(result.url).searchParams.get("body") ?? "");
    expect(body).toContain("copied to your clipboard");
    expect(body).toContain("**Correlation ID:** notif-corr-1");
    expect(result.url.length).toBeLessThanOrEqual(8192);
    expect(result.fullBody).toContain(longMessage);
  });

  it("falls back to 'unknown' correlation ID when null", () => {
    const result = buildNotificationReportUrl(makeNotificationInput({ correlationId: null }));
    expect(result.fullBody).toContain("**Correlation ID:** unknown");
  });

  it("omits the Type line when notificationType is undefined", () => {
    const result = buildNotificationReportUrl(
      makeNotificationInput({ notificationType: undefined })
    );
    expect(result.fullBody).not.toContain("**Type:**");
  });
});

describe("buildReportIssueUrl — plugin diagnostics", () => {
  function makePluginEntry(
    overrides: Partial<PluginDiagnosticsSnapshot["plugins"][number]> = {}
  ): PluginDiagnosticsSnapshot["plugins"][number] {
    return {
      pluginId: "acme.demo",
      displayName: "Demo Plugin",
      version: "2.0.0",
      source: "sideload",
      installedAt: 1700000000000,
      isBuiltin: false,
      devMode: false,
      disabled: false,
      archiveHash: "abc123",
      loadError: null,
      logLines: [{ ts: 1700000001000, level: "info", message: "started" }],
      auditRecords: [],
      ...overrides,
    };
  }

  it("renders a plugin diagnostics section when plugins are loaded", () => {
    const result = buildReportIssueUrl(
      makeInput({ pluginDiagnostics: { plugins: [makePluginEntry()] } })
    );
    expect(result.fullBody).toContain("Plugin diagnostics (1)");
    expect(result.fullBody).toContain("### Demo Plugin v2.0.0");
    expect(result.fullBody).toContain("- id: acme.demo");
    expect(result.fullBody).toContain("[info] started");
  });

  it("omits the section entirely when no plugins are loaded", () => {
    const empty = buildReportIssueUrl(makeInput({ pluginDiagnostics: { plugins: [] } }));
    expect(empty.fullBody).not.toContain("Plugin diagnostics");

    const nullish = buildReportIssueUrl(makeInput({ pluginDiagnostics: null }));
    expect(nullish.fullBody).not.toContain("Plugin diagnostics");
  });

  it("scrubs secrets and user paths in log lines", () => {
    const result = buildReportIssueUrl(
      makeInput({
        pluginDiagnostics: {
          plugins: [
            makePluginEntry({
              logLines: [
                { ts: 1700000001000, level: "error", message: "read /Users/alice/secret.txt" },
              ],
            }),
          ],
        },
      })
    );
    expect(result.fullBody).toContain("/Users/USER/secret.txt");
    expect(result.fullBody).not.toContain("/Users/alice/");
  });

  it("drops the diagnostics section but keeps system info when the URL budget is tight", () => {
    const bigLogLines = Array.from({ length: 500 }, (_, i) => ({
      ts: 1700000001000 + i,
      level: "info" as const,
      message: `log line number ${i} with some padding to inflate the encoded size`,
    }));
    const result = buildReportIssueUrl(
      makeInput({
        systemInfo: "os: macOS\napp: 1.0.0",
        pluginDiagnostics: { plugins: [makePluginEntry({ logLines: bigLogLines })] },
      })
    );

    // The diagnostics section is dropped (rung 4) but system info is kept —
    // the ladder must NOT fall through to the stub. Asserting systemInfo is
    // present guards against a regression that drops too much.
    expect(getEncodedBodyLength(result.url)).toBeLessThanOrEqual(URL_BODY_BUDGET);
    expect(result.usedClipboardFallback).toBe(false);
    expect(result.fullBody).toContain("Plugin diagnostics (1)");
    const urlBody = decodeURIComponent(new URL(result.url).searchParams.get("body") ?? "");
    expect(urlBody).not.toContain("log line number 250");
    expect(urlBody).toContain("<summary>System info</summary>");
  });

  it("does not throw on log lines containing multi-byte glyphs", () => {
    // A lone surrogate (from a naive code-unit slice upstream) would make
    // encodeURIComponent throw; assert a well-formed multi-byte line is safe.
    const result = buildReportIssueUrl(
      makeInput({
        pluginDiagnostics: {
          plugins: [
            makePluginEntry({
              logLines: [{ ts: 1700000001000, level: "info", message: "😀".repeat(50) }],
            }),
          ],
        },
      })
    );
    expect(() => new URL(result.url)).not.toThrow();
    expect(result.fullBody).toContain("😀");
  });

  it("adds a plugin-count line to the clipboard-fallback stub body", () => {
    // Long individual lines survive middle-truncation, forcing the stub path
    // (mirrors the existing clipboard-fallback fixture).
    const longLine = "x".repeat(1200);
    const stack = Array.from({ length: 25 }, () => longLine).join("\n");
    const componentStack = Array.from({ length: 10 }, () => longLine).join("\n");
    const result = buildReportIssueUrl(
      makeInput({
        stack,
        componentStack,
        pluginDiagnostics: {
          plugins: [makePluginEntry(), makePluginEntry({ pluginId: "acme.two" })],
        },
      })
    );
    expect(result.usedClipboardFallback).toBe(true);
    const urlBody = decodeURIComponent(new URL(result.url).searchParams.get("body") ?? "");
    expect(urlBody).toContain("2 plugins loaded");
  });
});
