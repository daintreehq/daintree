import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The module caches answers in module scope, so each test asks about its own
 * worktree rather than resetting the registry between them.
 */
async function loadApplies() {
  const module = await import("../SiteBuilderButton.js");
  return module.siteBuilderApplies;
}

function stubInvoke(invoke: (...args: unknown[]) => Promise<unknown>) {
  (globalThis as { window?: unknown }).window = { electron: { plugin: { invoke } } };
}

let worktree = 0;
function nextContext() {
  worktree += 1;
  return {
    projectId: `project-${worktree}`,
    worktreeId: `worktree-${worktree}`,
    worktreePath: `/repo/${worktree}`,
  };
}

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { window?: unknown }).window;
});

describe("the builder's availability answer", () => {
  it("asks again when main refuses an overloaded scan, rather than reporting no app", async () => {
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("SCAN_BUSY: too many worktree scans are already running; try again")
      )
      .mockResolvedValueOnce({ appCount: 1 });
    stubInvoke(invoke);

    const applies = await loadApplies();
    expect(await applies(nextContext() as never)).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("is unavailable when the walk stopped early without finding an app", async () => {
    // Almost every real repository stops the walk at its depth budget, so a
    // stopped walk says nothing about Svelte: treating it as "may apply" put
    // the tool in the toolbar of projects that have never used it.
    const invoke = vi.fn().mockResolvedValue({ appCount: 0, complete: false });
    stubInvoke(invoke);

    const applies = await loadApplies();
    expect(await applies(nextContext() as never)).toBe(false);
  });

  it("is available when a walk that stopped early had already found an app", async () => {
    const invoke = vi.fn().mockResolvedValue({ appCount: 1, complete: false });
    stubInvoke(invoke);

    const applies = await loadApplies();
    expect(await applies(nextContext() as never)).toBe(true);
  });

  it("is unavailable when a finished walk genuinely found no app", async () => {
    const invoke = vi.fn().mockResolvedValue({ appCount: 0, complete: true });
    stubInvoke(invoke);

    const applies = await loadApplies();
    expect(await applies(nextContext() as never)).toBe(false);
  });

  it("does not retry a lookup that failed for any other reason", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("EACCES: permission denied"));
    stubInvoke(invoke);

    const applies = await loadApplies();
    expect(await applies(nextContext() as never)).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("answers no when the queue is still full on the second ask, without caching it", async () => {
    const busy = () =>
      Promise.reject(
        new Error("SCAN_BUSY: too many worktree scans are already running; try again")
      );
    const invoke = vi.fn().mockImplementation(busy);
    stubInvoke(invoke);

    const applies = await loadApplies();
    const context = nextContext();
    expect(await applies(context as never)).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(2);

    // Not cached: the next ask starts a fresh lookup instead of repeating a
    // refusal we never established an answer from.
    invoke.mockResolvedValue({ appCount: 2 });
    expect(await applies(context as never)).toBe(true);
  });

  it("says no without asking when there is no workspace to scope the scan to", async () => {
    const invoke = vi.fn();
    stubInvoke(invoke);

    const applies = await loadApplies();
    expect(await applies({ projectId: "", worktreeId: "w", worktreePath: "/repo" } as never)).toBe(
      false
    );
    expect(invoke).not.toHaveBeenCalled();
  });
});
