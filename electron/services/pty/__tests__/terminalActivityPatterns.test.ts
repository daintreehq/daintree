import { describe, expect, it, vi } from "vitest";
import type { ProcessInfo } from "../../ProcessTreeCache.js";
import type { ProcessTreeCache } from "../../ProcessTreeCache.js";
import { createProcessStateValidator } from "../terminalActivityPatterns.js";

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
