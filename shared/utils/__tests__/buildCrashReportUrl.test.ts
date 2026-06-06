import { describe, it, expect } from "vitest";
import {
  buildCrashReportUrl,
  buildCrashReportUrlFromBody,
  formatRecentActions,
} from "../buildCrashReportUrl.js";
import type { ActionBreadcrumb, CrashLogEntry } from "../../types/ipc/crashRecovery.js";

function baseEntry(overrides: Partial<CrashLogEntry> = {}): CrashLogEntry {
  return {
    id: "crash-1",
    timestamp: 1700000000000,
    appVersion: "2.0.0",
    platform: "darwin",
    osVersion: "22.6.0",
    arch: "arm64",
    errorMessage: "Something went wrong",
    errorStack: "Error: Something went wrong\n  at main.ts:42",
    ...overrides,
  };
}

function action(overrides: Partial<ActionBreadcrumb> = {}): ActionBreadcrumb {
  return {
    id: "a1",
    actionId: "terminal.kill",
    category: "terminal",
    source: "user",
    danger: "safe",
    durationMs: 12,
    timestamp: 1699999990000,
    count: 1,
    ...overrides,
  };
}

function decodeBody(url: string): string {
  const match = url.match(/[?&]body=([^&]*)/);
  return match ? decodeURIComponent(match[1]!) : "";
}

function decodeTitle(url: string): string {
  const match = url.match(/[?&]title=([^&]*)/);
  return match ? decodeURIComponent(match[1]!) : "";
}

describe("buildCrashReportUrl", () => {
  it("fits a small report in the URL without clipboard fallback", () => {
    const result = buildCrashReportUrl(baseEntry());
    expect(result.usedClipboardFallback).toBe(false);
    expect(result.url).toContain("github.com/daintreehq/daintree/issues/new");
    expect(decodeBody(result.url)).toContain("Something went wrong");
  });

  it("includes the recent-actions trail in the body", () => {
    const result = buildCrashReportUrl(
      baseEntry({ recentActions: [action({ actionId: "git.push" })] })
    );
    const body = decodeBody(result.url);
    expect(body).toContain("Recent actions (1)");
    expect(body).toContain("git.push");
  });

  it("omits the actions table when recentActions is empty or undefined", () => {
    expect(decodeBody(buildCrashReportUrl(baseEntry()).url)).not.toContain("Recent actions");
    expect(decodeBody(buildCrashReportUrl(baseEntry({ recentActions: [] })).url)).not.toContain(
      "Recent actions"
    );
  });

  it("redacts macOS user paths", () => {
    const result = buildCrashReportUrl(
      baseEntry({ errorMessage: "ENOENT at /Users/alice/project/file.ts" })
    );
    const body = decodeBody(result.url);
    expect(body).toContain("/Users/USER/project/file.ts");
    expect(body).not.toContain("alice");
  });

  it("redacts Linux user paths", () => {
    const result = buildCrashReportUrl(baseEntry({ errorMessage: "fail at /home/bob/code/x.ts" }));
    expect(decodeBody(result.url)).toContain("/home/USER/code/x.ts");
  });

  it("redacts Windows backslash user paths", () => {
    const result = buildCrashReportUrl(
      baseEntry({ errorMessage: "fail at C:\\Users\\Carol\\app\\x.ts" })
    );
    const body = decodeBody(result.url);
    expect(body).toContain("C:\\Users\\USER\\app\\x.ts");
    expect(body).not.toContain("Carol");
  });

  it("scrubs secrets found in action args", () => {
    const result = buildCrashReportUrl(
      baseEntry({
        recentActions: [
          action({ args: { token: "ghp_0123456789012345678901234567890123456789" } }),
        ],
      })
    );
    const body = decodeBody(result.url);
    expect(body).toContain("[REDACTED]");
    expect(body).not.toContain("ghp_0123456789");
  });

  it("scrubs user paths found in action args", () => {
    const result = buildCrashReportUrl(
      baseEntry({ recentActions: [action({ args: { cwd: "/Users/dave/repo" } })] })
    );
    const body = decodeBody(result.url);
    expect(body).toContain("/Users/USER/repo");
    expect(body).not.toContain("dave");
  });

  it("falls back to the clipboard for oversized reports", () => {
    const result = buildCrashReportUrl(baseEntry({ errorStack: "x".repeat(10000) }));
    expect(result.usedClipboardFallback).toBe(true);
    // fullBody keeps the complete (redacted) report for the clipboard.
    expect(result.fullBody).toContain("x".repeat(10000));
    // The URL body is the short stub pointing the user at the clipboard.
    expect(decodeBody(result.url)).toContain("copied to your clipboard");
  });

  it("drops the actions trail before resorting to the clipboard", () => {
    const manyActions = Array.from({ length: 400 }, (_, i) =>
      action({ id: `a${i}`, actionId: `action.number.${i}` })
    );
    const result = buildCrashReportUrl(baseEntry({ recentActions: manyActions }));
    // The dropped-actions stage keeps the URL valid without clipboard fallback.
    expect(result.usedClipboardFallback).toBe(false);
    expect(decodeBody(result.url)).not.toContain("Recent actions");
    // But the clipboard-ready fullBody still carries everything.
    expect(result.fullBody).toContain("Recent actions");
  });

  it("does not throw on unserializable action args", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      buildCrashReportUrl(baseEntry({ recentActions: [action({ args: circular })] }))
    ).not.toThrow();
  });

  it("does not throw on a corrupt action timestamp", () => {
    expect(() =>
      buildCrashReportUrl(baseEntry({ recentActions: [action({ timestamp: NaN })] }))
    ).not.toThrow();
  });

  it("redacts user paths in the issue title", () => {
    const result = buildCrashReportUrl(baseEntry({ errorMessage: "ENOENT /Users/alice/file.ts" }));
    const title = decodeTitle(result.url);
    expect(title).toContain("/Users/USER/file.ts");
    expect(title).not.toContain("alice");
  });

  it("redacts secrets in the issue title", () => {
    const result = buildCrashReportUrl(
      baseEntry({ errorMessage: "token ghp_0123456789012345678901234567890123456789 rejected" })
    );
    expect(decodeTitle(result.url)).not.toContain("ghp_0123456789");
  });

  it("redacts Windows backslash paths inside JSON-stringified action args", () => {
    const result = buildCrashReportUrl(
      baseEntry({ recentActions: [action({ args: { cwd: "C:\\Users\\Carol\\repo" } })] })
    );
    const body = decodeBody(result.url);
    expect(body).not.toContain("Carol");
    expect(body).toContain("USER");
  });

  it("redacts WSL UNC user paths", () => {
    const result = buildCrashReportUrl(
      baseEntry({ errorMessage: "ENOENT at \\\\wsl$\\Ubuntu\\home\\alice\\file.ts" })
    );
    const body = decodeBody(result.url);
    expect(body).not.toContain("alice");
    expect(body).toContain("Ubuntu");
  });

  it("redacts non-C-drive Windows paths inside action args", () => {
    const result = buildCrashReportUrl(
      baseEntry({ recentActions: [action({ args: { cwd: "D:\\Users\\Carol\\repo" } })] })
    );
    const body = decodeBody(result.url);
    expect(body).not.toContain("Carol");
    expect(body).toContain("USER");
  });

  it("middle-truncates a long stack before falling back to the clipboard", () => {
    // 200 frames push the full body well past the URL budget, but the 15-head +
    // 5-tail truncation brings it back under, so this hits stage 3 (not the stub).
    const frame = (i: number) =>
      `  at deeplyNestedFunctionCall (/app/src/components/some/nested/module/file-${i}-.ts:${i}:7)`;
    const stack = ["Error: boom", ...Array.from({ length: 200 }, (_, i) => frame(i))].join("\n");
    const result = buildCrashReportUrl(baseEntry({ errorStack: stack }));
    const body = decodeBody(result.url);
    expect(result.usedClipboardFallback).toBe(false);
    expect(body).toContain("middle frames truncated");
    expect(body).toContain("file-0-.ts"); // head frame retained
    expect(body).toContain("file-199-.ts"); // tail frame retained
    expect(body).not.toContain("file-100-.ts"); // middle frame dropped
  });

  it("surfaces the watchdog cause in the title when there is no message", () => {
    const result = buildCrashReportUrl(
      baseEntry({ errorMessage: undefined, cause: "watchdog-deadlock" })
    );
    expect(result.url).toContain(encodeURIComponent("watchdog-deadlock"));
  });
});

describe("buildCrashReportUrlFromBody", () => {
  it("embeds an edited body that fits the budget", () => {
    const result = buildCrashReportUrlFromBody(baseEntry(), "Edited report body");
    expect(result.usedClipboardFallback).toBe(false);
    expect(decodeBody(result.url)).toBe("Edited report body");
  });

  it("falls back to the clipboard when the edited body is too long", () => {
    const result = buildCrashReportUrlFromBody(baseEntry(), "y".repeat(10000));
    expect(result.usedClipboardFallback).toBe(true);
    expect(result.fullBody).toBe("y".repeat(10000));
    expect(decodeBody(result.url)).toContain("copied to your clipboard");
  });
});

describe("formatRecentActions", () => {
  it("returns an empty string for no actions", () => {
    expect(formatRecentActions(undefined)).toBe("");
    expect(formatRecentActions([])).toBe("");
  });

  it("escapes pipes in args so the table stays intact", () => {
    const out = formatRecentActions([action({ args: { q: "a|b" } })]);
    expect(out).toContain("a\\|b");
  });

  it("shows the danger label only for non-safe actions", () => {
    const safe = formatRecentActions([action({ danger: "safe" })]);
    const confirm = formatRecentActions([action({ danger: "confirm" })]);
    // The safe row leaves the danger cell empty; the confirm row names it.
    expect(confirm).toContain("confirm");
    expect(safe).not.toMatch(/\|\s*confirm\s*\|/);
  });
});
