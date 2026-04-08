import { describe, expect, it } from "vitest";

// Test the promise pool helper logic and allRequired derivation.
// These mirror the production code used by SystemToolsStep and AgentCliStep.

describe("Promise pool concurrency", () => {
  async function runPool<T>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<void>
  ): Promise<void> {
    const iter = items[Symbol.iterator]();
    async function worker() {
      for (let next = iter.next(); !next.done; next = iter.next()) {
        await fn(next.value);
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
  }

  it("should process all items", async () => {
    const results: number[] = [];
    await runPool([1, 2, 3, 4, 5], 2, async (item) => {
      results.push(item);
    });
    expect(results.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("should respect concurrency limit", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    await runPool([1, 2, 3, 4, 5, 6], 3, async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 10));
      concurrent--;
    });

    expect(maxConcurrent).toBeLessThanOrEqual(3);
    expect(maxConcurrent).toBeGreaterThanOrEqual(1);
  });

  it("should handle empty items", async () => {
    const results: number[] = [];
    await runPool([], 3, async (item: number) => {
      results.push(item);
    });
    expect(results).toEqual([]);
  });

  it("should continue processing when caller wraps errors in try/catch", async () => {
    const results: number[] = [];
    const errors: number[] = [];

    await runPool([1, 2, 3, 4], 2, async (item) => {
      try {
        if (item === 2) throw new Error("fail");
        results.push(item);
      } catch {
        errors.push(item);
      }
    });

    expect(results).toEqual([1, 3, 4]);
    expect(errors).toEqual([2]);
  });
});

describe("allRequired derivation", () => {
  type CheckState = "loading" | { available: boolean; meetsMinVersion: boolean; severity: string };

  function deriveAllRequired(
    specs: Array<{ tool: string; severity: string }>,
    checkStates: Record<string, CheckState>
  ): boolean {
    return specs
      .filter((s) => s.severity === "fatal")
      .every((s) => {
        const state = checkStates[s.tool];
        return (
          state !== "loading" && state !== undefined && state.available && state.meetsMinVersion
        );
      });
  }

  it("should return true when all fatal checks pass", () => {
    const specs = [
      { tool: "git", severity: "fatal" },
      { tool: "npm", severity: "warn" },
    ];
    const states: Record<string, CheckState> = {
      git: { available: true, meetsMinVersion: true, severity: "fatal" },
      npm: { available: false, meetsMinVersion: false, severity: "warn" },
    };
    expect(deriveAllRequired(specs, states)).toBe(true);
  });

  it("should return false when a fatal check fails", () => {
    const specs = [
      { tool: "git", severity: "fatal" },
      { tool: "node", severity: "fatal" },
    ];
    const states: Record<string, CheckState> = {
      git: { available: true, meetsMinVersion: true, severity: "fatal" },
      node: { available: false, meetsMinVersion: false, severity: "fatal" },
    };
    expect(deriveAllRequired(specs, states)).toBe(false);
  });

  it("should return false when a fatal check is still loading", () => {
    const specs = [{ tool: "git", severity: "fatal" }];
    const states: Record<string, CheckState> = { git: "loading" };
    expect(deriveAllRequired(specs, states)).toBe(false);
  });
});
