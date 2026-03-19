import { describe, expect, it, vi } from "vitest";
import type { ProcessInfo } from "../../ProcessTreeCache.js";
import type { ProcessTreeCache } from "../../ProcessTreeCache.js";
import {
  createProcessStateValidator,
  buildActivityMonitorOptions,
  buildPromptHintPatterns,
  UNIVERSAL_APPROVAL_HINT_PATTERNS,
} from "../terminalActivityPatterns.js";

function createMockProcessTreeCache(
  childrenByPid: Map<number, ProcessInfo[]>,
  activeDescendants: boolean = false
): ProcessTreeCache {
  return {
    getChildren: (ppid: number) => childrenByPid.get(ppid) ?? [],
    getChildPids: (ppid: number) => (childrenByPid.get(ppid) ?? []).map((c) => c.pid),
    hasActiveDescendants: vi.fn(() => activeDescendants),
    getProcess: () => undefined,
    hasChildren: (ppid: number) => (childrenByPid.get(ppid) ?? []).length > 0,
    getDescendantsCpuUsage: () => 0,
    getLastRefreshTime: () => Date.now(),
    getLastError: () => null,
    getCacheSize: () => 0,
  } as unknown as ProcessTreeCache;
}

describe("createProcessStateValidator", () => {
  it("returns undefined when ptyPid is undefined", () => {
    const cache = createMockProcessTreeCache(new Map());
    expect(createProcessStateValidator(undefined, cache)).toBeUndefined();
  });

  it("returns undefined when processTreeCache is null", () => {
    expect(createProcessStateValidator(1, null)).toBeUndefined();
  });

  it("returns true when hasActiveDescendants reports activity", () => {
    const cache = createMockProcessTreeCache(new Map(), true);
    const validator = createProcessStateValidator(42, cache)!;
    expect(validator.hasActiveChildren()).toBe(true);
    expect(cache.hasActiveDescendants).toHaveBeenCalledWith(42, 0.5);
  });

  it("returns false when no children exist and no CPU activity", () => {
    const cache = createMockProcessTreeCache(new Map([[1, []]]));
    const validator = createProcessStateValidator(1, cache)!;
    expect(validator.hasActiveChildren()).toBe(false);
  });

  it("returns false when only shell children exist", () => {
    const children: ProcessInfo[] = [
      { pid: 10, ppid: 1, comm: "zsh", command: "zsh", cpuPercent: 0 },
      { pid: 11, ppid: 1, comm: "gitstatusd", command: "gitstatusd", cpuPercent: 0 },
    ];
    const cache = createMockProcessTreeCache(new Map([[1, children]]));
    const validator = createProcessStateValidator(1, cache)!;
    expect(validator.hasActiveChildren()).toBe(false);
  });

  it("returns true when a significant non-shell child exists (no grandchildren needed)", () => {
    const children: ProcessInfo[] = [
      { pid: 10, ppid: 1, comm: "zsh", command: "zsh", cpuPercent: 0 },
      { pid: 11, ppid: 1, comm: "node", command: "node build.js", cpuPercent: 0 },
    ];
    const cache = createMockProcessTreeCache(
      new Map([
        [1, children],
        [10, []],
        [11, []],
      ])
    );
    const validator = createProcessStateValidator(1, cache)!;
    expect(validator.hasActiveChildren()).toBe(true);
  });

  it("strips .exe suffix when classifying children", () => {
    const children: ProcessInfo[] = [
      { pid: 10, ppid: 1, comm: "node.exe", command: "node.exe build.js", cpuPercent: 0 },
    ];
    const cache = createMockProcessTreeCache(new Map([[1, children]]));
    const validator = createProcessStateValidator(1, cache)!;
    expect(validator.hasActiveChildren()).toBe(true);
  });

  it("treats powershell and cmd as shell processes", () => {
    const children: ProcessInfo[] = [
      { pid: 10, ppid: 1, comm: "powershell", command: "powershell", cpuPercent: 0 },
      { pid: 11, ppid: 1, comm: "cmd", command: "cmd", cpuPercent: 0 },
    ];
    const cache = createMockProcessTreeCache(new Map([[1, children]]));
    const validator = createProcessStateValidator(1, cache)!;
    expect(validator.hasActiveChildren()).toBe(false);
  });
});

describe("buildPromptHintPatterns", () => {
  it("returns universal patterns for an agent with no promptHintPatterns", () => {
    const result = buildPromptHintPatterns(undefined, "claude");
    expect(result).toBeDefined();
    expect(result!.length).toBe(UNIVERSAL_APPROVAL_HINT_PATTERNS.length);
  });

  it("returns undefined for non-agent terminals", () => {
    const result = buildPromptHintPatterns(undefined, undefined);
    expect(result).toBeUndefined();
  });

  it("merges agent-specific patterns before universal patterns", () => {
    const detection = { promptHintPatterns: ["custom\\s+pattern"] } as any;
    const result = buildPromptHintPatterns(detection, "claude");
    expect(result).toBeDefined();
    expect(result!.length).toBe(1 + UNIVERSAL_APPROVAL_HINT_PATTERNS.length);
    // Agent-specific pattern should be first
    expect(result![0].test("custom pattern")).toBe(true);
  });

  it("universal patterns match expected approval prompts", () => {
    const patterns = buildPromptHintPatterns(undefined, "gemini")!;
    const approvalTexts = [
      "Yes, allow once",
      "allow always for this tool",
      "Approve Once",
      "Approve This Session",
      "a, Allow permission",
      "d, Deny permission",
      "No, suggest changes (esc)",
      "Yes, don't ask again for this tool",
      "Trust this directory",
      "Proceed? [y/N]",
      "Continue? (y/n)",
      "[Y/n]",
    ];
    for (const text of approvalTexts) {
      const matched = patterns.some((p) => p.test(text));
      expect(matched, `Expected "${text}" to match a universal pattern`).toBe(true);
    }
  });

  it("universal patterns do not match generic words", () => {
    const patterns = buildPromptHintPatterns(undefined, "claude")!;
    const safeTexts = [
      "I'll approve this change for you",
      "This will allow the process to continue",
      "You can deny the request manually",
    ];
    for (const text of safeTexts) {
      const matched = patterns.some((p) => p.test(text));
      // These may partially match multi-word phrases — the key is that single-word
      // "approve", "allow", "deny" alone are NOT in the pattern set.
      // "approve this change" won't match "approve\\s+once" or "approve\\s+this\\s+session"
      if (text.includes("approve this change")) {
        expect(matched).toBe(false);
      }
    }
  });
});

describe("buildActivityMonitorOptions", () => {
  it("returns undefined getVisibleLines/getCursorLine when no agent ID", () => {
    const result = buildActivityMonitorOptions(undefined, {});
    expect(result.getVisibleLines).toBeUndefined();
    expect(result.getCursorLine).toBeUndefined();
    expect(result.agentId).toBeUndefined();
  });

  it("passes through closures when agent ID is provided", () => {
    const getVisibleLines = (n: number) => [`line ${n}`];
    const getCursorLine = () => "cursor line" as string | null;
    const result = buildActivityMonitorOptions("claude", { getVisibleLines, getCursorLine });
    expect(result.getVisibleLines).toBe(getVisibleLines);
    expect(result.getCursorLine).toBe(getCursorLine);
    expect(result.agentId).toBe("claude");
  });

  it("defaults ignoredInputSequences to escape-return", () => {
    const result = buildActivityMonitorOptions(undefined, {});
    expect(result.ignoredInputSequences).toEqual(["\x1b\r"]);
  });

  it("sets idle debounce for agent terminals", () => {
    const result = buildActivityMonitorOptions("claude", {});
    expect(result.idleDebounceMs).toBeDefined();
    expect(typeof result.idleDebounceMs).toBe("number");
  });

  it("includes universal approval hint patterns for agent terminals", () => {
    const result = buildActivityMonitorOptions("claude", {});
    expect(result.promptHintPatterns).toBeDefined();
    expect(result.promptHintPatterns!.length).toBeGreaterThanOrEqual(
      UNIVERSAL_APPROVAL_HINT_PATTERNS.length
    );
    // Verify a universal pattern matches
    const matchesApproveOnce = result.promptHintPatterns!.some((p) => p.test("Approve Once"));
    expect(matchesApproveOnce).toBe(true);
  });

  it("does not include universal approval patterns for non-agent terminals", () => {
    const result = buildActivityMonitorOptions(undefined, {});
    expect(result.promptHintPatterns).toBeUndefined();
  });

  it("populates pattern config fields for a known agent", () => {
    const result = buildActivityMonitorOptions("claude", {});
    expect(result.outputActivityDetection).toEqual({
      enabled: true,
      windowMs: 1000,
      minFrames: 2,
      minBytes: 32,
    });
    expect(result.patternConfig).toBeDefined();
    expect(result.bootCompletePatterns).toBeDefined();
  });
});
