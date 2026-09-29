import { describe, expect, it, vi } from "vitest";
import type { SafeBootResult } from "@/lib/bootPromise";
import type { BootResult } from "@shared/types/ipc/app";

const PANE_MODULES: Record<string, { path: string; name: string }> = {
  browser: { path: "@/components/Browser/BrowserPane", name: "BrowserPane" },
  "dev-preview": { path: "@/components/DevPreview/DevPreviewPane", name: "DevPreviewPane" },
  review: { path: "../review/ReviewPane", name: "ReviewPane" },
  file: { path: "../file/FilePane", name: "FilePane" },
  diff: { path: "../diff/DiffPane", name: "DiffPane" },
  "file-browser": { path: "../file-browser/FileBrowserPane", name: "FileBrowserPane" },
};

async function loadRegistry() {
  vi.resetModules();
  const loaded: string[] = [];
  vi.doMock("@/components/Terminal/TerminalPane", () => ({ TerminalPane: () => null }));
  for (const { path, name } of Object.values(PANE_MODULES)) {
    vi.doMock(path, () => {
      loaded.push(name);
      return { [name]: () => null };
    });
  }
  const registry = await import("../registry");
  return { ...registry, loaded };
}

async function settle(loaded: string[], expected: number): Promise<void> {
  await vi.waitFor(() => expect(loaded.length).toBeGreaterThanOrEqual(expected));
  // One more macrotask so an unexpected extra import would also have landed.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function boot(terminals: unknown): SafeBootResult {
  return {
    ok: true,
    result: { appState: { terminals }, workspaceId: "proj-1" } as unknown as BootResult,
  };
}

describe("preloadRestoredPanes", () => {
  it("loads only the pane chunks for the kinds the session restores", async () => {
    const { preloadRestoredPanes, loaded } = await loadRegistry();
    preloadRestoredPanes(["terminal", "diff", "file", "terminal"]);
    await settle(loaded, 2);
    expect([...loaded].sort()).toEqual(["DiffPane", "FilePane"]);
  });

  it("maps every firstRenderRestore kind to its own pane chunk", async () => {
    const { getBuiltInPanelKinds, getPanelKindConfig } =
      await import("@shared/config/panelKindRegistry");
    const firstRenderKinds = getBuiltInPanelKinds().filter(
      (kind) => getPanelKindConfig(kind)?.firstRenderRestore === true
    );
    expect([...firstRenderKinds].sort()).toEqual(Object.keys(PANE_MODULES).sort());
    for (const kind of firstRenderKinds) {
      const { preloadRestoredPanes, loaded } = await loadRegistry();
      preloadRestoredPanes([kind]);
      await settle(loaded, 1);
      expect(loaded, kind).toEqual([PANE_MODULES[kind]!.name]);
    }
  });

  it("ignores terminals, unknown kinds and plugin kinds", async () => {
    const { preloadRestoredPanes, loaded } = await loadRegistry();
    preloadRestoredPanes(["terminal", undefined, "acme.dashboard.overview", "project:x", "nope"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loaded).toEqual([]);
  });
});

describe("preloadRestoredPanesFromBoot", () => {
  it("warms the kinds in the boot payload's restored panels", async () => {
    const { preloadRestoredPanesFromBoot, loaded } = await loadRegistry();
    preloadRestoredPanesFromBoot(
      boot([
        { id: "t1", kind: "terminal", title: "", location: "grid" },
        { id: "d1", kind: "diff", title: "", location: "grid" },
      ])
    );
    await settle(loaded, 1);
    expect(loaded).toEqual(["DiffPane"]);
  });

  it("normalizes legacy kinds the way panel restore does", async () => {
    const { preloadRestoredPanesFromBoot, loaded } = await loadRegistry();
    preloadRestoredPanesFromBoot(
      boot([
        { id: "m1", kind: "markdown", title: "", location: "grid" },
        { id: "b1", title: "", location: "grid", browserUrl: "http://localhost:3000" },
      ])
    );
    await settle(loaded, 2);
    expect([...loaded].sort()).toEqual(["BrowserPane", "FilePane"]);
  });

  it("warms nothing for a failed boot or a payload without restored panels", async () => {
    const { preloadRestoredPanesFromBoot, loaded } = await loadRegistry();
    preloadRestoredPanesFromBoot({ ok: false, error: new Error("boot failed") });
    preloadRestoredPanesFromBoot(boot(undefined));
    preloadRestoredPanesFromBoot({ ok: true, result: {} as unknown as BootResult });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loaded).toEqual([]);
  });
});
