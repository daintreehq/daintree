import { describe, expect, it, vi } from "vitest";
import type { ProcessInfo } from "../../ProcessTreeCache.js";
import type { ProcessTreeCache } from "../../ProcessTreeCache.js";
import {
  createProcessStateValidator,
  buildActivityMonitorOptions,
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
