// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { ForgeProviderEntry, ResolvedForgeProvider } from "@shared/types/forge";

const GITHUB_ENTRY: ForgeProviderEntry = {
  pluginId: "daintree.github",
  contribution: { id: "github", name: "GitHub", matches: ["github.com"] },
};

const resolveProviderMock = vi.fn<(projectId: string) => Promise<ResolvedForgeProvider>>();

// Mirror the preload event multiplexer: all subscribers fire synchronously in
// one tick — the shape that exposed the cross-instance stale-response bug.
let provenanceCallbacks: Array<() => void> = [];
function fireProvenanceChanged(): void {
  for (const cb of [...provenanceCallbacks]) cb();
}

vi.stubGlobal("electron", undefined);
Object.defineProperty(window, "electron", {
  configurable: true,
  value: {
    forge: {
      resolveProvider: (projectId: string) => resolveProviderMock(projectId),
    },
    plugin: {
      onProvenanceChanged: (cb: () => void) => {
        provenanceCallbacks.push(cb);
        return () => {
          provenanceCallbacks = provenanceCallbacks.filter((c) => c !== cb);
        };
      },
    },
  },
});

import { useResolvedForgeProvider } from "../useResolvedForgeProvider";

let projectSeq = 0;
/** Fresh id per test so the hook's module-level cache/seq maps can't leak state. */
function nextProjectId(): string {
  return `project-${++projectSeq}`;
}

describe("useResolvedForgeProvider", () => {
  beforeEach(() => {
    provenanceCallbacks = [];
    resolveProviderMock.mockReset();
  });

  it("resolves the provider entry on mount", async () => {
    resolveProviderMock.mockResolvedValue({ entry: GITHUB_ENTRY, resolvedVia: "hostname" });
    const projectId = nextProjectId();

    const { result } = renderHook(() => useResolvedForgeProvider(projectId));
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.entry).toEqual(GITHUB_ENTRY));
    expect(result.current.providerId).toBe("daintree.github.github");
    expect(result.current.resolvedVia).toBe("hostname");
    expect(result.current.loading).toBe(false);
  });

  it("drops to null on a provenance change after the owning plugin is disabled", async () => {
    resolveProviderMock.mockResolvedValue({ entry: GITHUB_ENTRY, resolvedVia: "hostname" });
    const projectId = nextProjectId();

    const { result } = renderHook(() => useResolvedForgeProvider(projectId));
    await waitFor(() => expect(result.current.entry).toEqual(GITHUB_ENTRY));

    resolveProviderMock.mockResolvedValue({ entry: null, resolvedVia: null });
    act(() => fireProvenanceChanged());

    await waitFor(() => expect(result.current.entry).toBeNull());
    expect(result.current.providerId).toBeNull();
  });

  it("converges EVERY concurrently-mounted instance on a provenance change", async () => {
    // Regression: Toolbar, ForgeStatsToolbarButton, SidebarContent, and
    // useRepositoryStats all hold an instance for the same project. A
    // provenance event re-resolves all of them in the same tick; with the
    // shared stale-response guard gating setState, only the last instance to
    // start kept its response — the others held a stale entry and the stats
    // pill survived a live plugin disable.
    resolveProviderMock.mockResolvedValue({ entry: GITHUB_ENTRY, resolvedVia: "hostname" });
    const projectId = nextProjectId();

    const instances = Array.from({ length: 4 }, () =>
      renderHook(() => useResolvedForgeProvider(projectId))
    );
    for (const { result } of instances) {
      await waitFor(() => expect(result.current.entry).toEqual(GITHUB_ENTRY));
    }

    resolveProviderMock.mockResolvedValue({ entry: null, resolvedVia: null });
    act(() => fireProvenanceChanged());

    for (const { result } of instances) {
      await waitFor(() => expect(result.current.entry).toBeNull());
    }
  });

  it("a stale same-instance response never overwrites a newer one", async () => {
    const projectId = nextProjectId();
    let resolveFirst: (value: ResolvedForgeProvider) => void = () => {};
    resolveProviderMock.mockImplementationOnce(
      () =>
        new Promise<ResolvedForgeProvider>((resolve) => {
          resolveFirst = resolve;
        })
    );

    const { result } = renderHook(() => useResolvedForgeProvider(projectId));

    // Second resolve (provenance-triggered) settles first with null...
    resolveProviderMock.mockResolvedValue({ entry: null, resolvedVia: null });
    act(() => fireProvenanceChanged());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.entry).toBeNull();

    // ...then the slow first response lands and must be discarded.
    act(() => resolveFirst({ entry: GITHUB_ENTRY, resolvedVia: "hostname" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.entry).toBeNull();
  });

  it("an instance mounting after resolution serves the cached answer immediately", async () => {
    resolveProviderMock.mockResolvedValue({ entry: GITHUB_ENTRY, resolvedVia: "hostname" });
    const projectId = nextProjectId();

    const first = renderHook(() => useResolvedForgeProvider(projectId));
    await waitFor(() => expect(first.result.current.entry).toEqual(GITHUB_ENTRY));

    const second = renderHook(() => useResolvedForgeProvider(projectId));
    // No unresolved flash: initial state comes straight from the cache.
    expect(second.result.current.entry).toEqual(GITHUB_ENTRY);
    expect(second.result.current.loading).toBe(false);
  });
});
