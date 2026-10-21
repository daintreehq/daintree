import { afterEach, describe, expect, it, vi } from "vitest";
import { siteBuilderApplies, SITE_BUILDER_UNAVAILABLE_REASON } from "../SiteBuilderButton.js";

function stubInvoke(invoke: (...args: unknown[]) => Promise<unknown>) {
  (globalThis as { window?: unknown }).window = { electron: { plugin: { invoke } } };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("the picker's availability answer", () => {
  it("is available on any worktree's preview, without looking for a SvelteKit app", async () => {
    // A Vite + React or Next.js worktree has no SvelteKit app in it, and the
    // picker works there all the same: scanning for one would only hide it.
    const invoke = vi.fn().mockResolvedValue({ appCount: 0, complete: true });
    stubInvoke(invoke);

    expect(
      await siteBuilderApplies({
        projectId: "project",
        worktreeId: "worktree",
        worktreePath: "/repo/react-app",
      } as never)
    ).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("says no when the preview belongs to no worktree, which a request could go to", async () => {
    const invoke = vi.fn();
    stubInvoke(invoke);

    for (const context of [
      { projectId: "", worktreeId: "w", worktreePath: "/repo" },
      { projectId: "p", worktreeId: null, worktreePath: "/repo" },
      { projectId: "p", worktreeId: "w", worktreePath: null },
    ]) {
      expect(await siteBuilderApplies(context as never)).toBe(false);
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses a command with a reason that names no framework", () => {
    expect(SITE_BUILDER_UNAVAILABLE_REASON).not.toMatch(/svelte/i);
  });
});
