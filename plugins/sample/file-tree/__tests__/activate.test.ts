import { describe, expect, it } from "vitest";
import { activate } from "../main/index.js";
import { createMockHost } from "../../../../shared/testing/createMockHost.js";
import type { PluginIpcContext } from "../../../../shared/types/plugin.js";

function makeCtx(overrides: Partial<PluginIpcContext> = {}): PluginIpcContext {
  return {
    projectId: "project-1",
    worktreeId: "wt-1",
    webContentsId: 0,
    pluginId: "daintree.filetree",
    ...overrides,
  };
}

/**
 * The sample shipped for months with `registerHandler("list-directory", (args) => …)`,
 * which binds `args` to the IPC context and drops the payload — so `dirPath` was
 * always `undefined`, the handler always threw, and every directory rendered
 * "unreadable" (#12215). These tests pin the dispatch convention the host
 * actually uses, `handler(ctx, ...args)`, so a regression to the one-parameter
 * form fails here rather than in a third-party plugin that copied it.
 */
describe("file-tree activate (against createMockHost)", () => {
  it("reads the payload from the second parameter, not the first", async () => {
    const host = createMockHost({ pluginId: "daintree.filetree" });
    await host.fs.writeFile("/repo/src/index.ts", "export {};");
    await host.fs.writeFile("/repo/README.md", "# repo");
    await activate(host);

    const list = host.registeredHandlers.find((h) => h.channel === "list-directory");
    expect(list).toBeDefined();

    const entries = (await list!.handler(makeCtx(), { dirPath: "/repo" })) as Array<{
      name: string;
      isDirectory: boolean;
    }>;
    expect(entries.map((e) => e.name).sort()).toEqual(["README.md", "src"]);
    expect(entries.find((e) => e.name === "src")?.isDirectory).toBe(true);
  });

  it("rejects the payload passed in the context position", async () => {
    const host = createMockHost({ pluginId: "daintree.filetree" });
    await activate(host);
    const list = host.registeredHandlers.find((h) => h.channel === "list-directory");

    // The exact shape of the old bug: a handler that read arg 0 saw this and
    // found no `dirPath`. Dispatch never calls a handler this way, so the
    // payload-shaped context must not be mistaken for a payload.
    await expect(
      list!.handler({ dirPath: "/repo" } as unknown as PluginIpcContext)
    ).rejects.toThrow("list-directory requires a dirPath");
  });

  it("reports the active worktree over the argument-less root channel", async () => {
    const host = createMockHost({
      pluginId: "daintree.filetree",
      activeWorktree: {
        id: "wt-1",
        worktreeId: "wt-1",
        path: "/repo",
        name: "main",
        isCurrent: true,
        linked: null,
      },
    });
    await activate(host);

    const root = host.registeredHandlers.find((h) => h.channel === "root");
    expect(await root!.handler(makeCtx())).toEqual({ path: "/repo" });
  });
});
