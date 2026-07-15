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

// Same multiplexer shape for `forge:remote-changed` (#11155), which unlike
// provenance carries the project it applies to.
let remoteChangedCallbacks: Array<(payload: { projectId: string }) => void> = [];
function fireRemoteChanged(projectId: string): void {
  for (const cb of [...remoteChangedCallbacks]) cb({ projectId });
}

vi.stubGlobal("electron", undefined);
Object.defineProperty(window, "electron", {
  configurable: true,
  value: {
    forge: {
      resolveProvider: (projectId: string) => resolveProviderMock(projectId),
      onRemoteChanged: (cb: (payload: { projectId: string }) => void) => {
        remoteChangedCallbacks.push(cb);
        return () => {
          remoteChangedCallbacks = remoteChangedCallbacks.filter((c) => c !== cb);
        };
      },
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
    remoteChangedCallbacks = [];
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

  describe("remote-changed invalidation (#11155)", () => {
    it("resolves a provider after an origin is added to an open project", async () => {
      // The bug: `git remote add origin` in an already-open project left the
      // toolbar pills hidden until a reload, because the hook resolved once on
      // mount (unresolved) and the toolbar never unmounts to re-ask.
      resolveProviderMock.mockResolvedValue({ entry: null, resolvedVia: null });
      const projectId = nextProjectId();

      const { result } = renderHook(() => useResolvedForgeProvider(projectId));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.providerId).toBeNull();

      resolveProviderMock.mockResolvedValue({ entry: GITHUB_ENTRY, resolvedVia: "hostname" });
      act(() => fireRemoteChanged(projectId));

      await waitFor(() => expect(result.current.entry).toEqual(GITHUB_ENTRY));
      expect(result.current.providerId).toBe("daintree.github.github");
    });

    it("ignores a remote change on a different project", async () => {
      resolveProviderMock.mockResolvedValue({ entry: null, resolvedVia: null });
      const projectId = nextProjectId();
      const otherProjectId = nextProjectId();

      const { result } = renderHook(() => useResolvedForgeProvider(projectId));
      await waitFor(() => expect(result.current.loading).toBe(false));
      const callsAfterMount = resolveProviderMock.mock.calls.length;

      resolveProviderMock.mockResolvedValue({ entry: GITHUB_ENTRY, resolvedVia: "hostname" });
      act(() => fireRemoteChanged(otherProjectId));
      await act(async () => {
        await Promise.resolve();
      });

      // A sibling project's remote says nothing about this one's resolution.
      expect(resolveProviderMock.mock.calls.length).toBe(callsAfterMount);
      expect(result.current.entry).toBeNull();
    });

    it("converges every concurrently-mounted instance for the project", async () => {
      // Same fan-out as the provenance case: the toolbar, the stats pill and
      // the sidebar each hold an instance, and all must see the new provider.
      resolveProviderMock.mockResolvedValue({ entry: null, resolvedVia: null });
      const projectId = nextProjectId();

      const instances = Array.from({ length: 3 }, () =>
        renderHook(() => useResolvedForgeProvider(projectId))
      );
      for (const { result } of instances) {
        await waitFor(() => expect(result.current.loading).toBe(false));
      }

      resolveProviderMock.mockResolvedValue({ entry: GITHUB_ENTRY, resolvedVia: "hostname" });
      act(() => fireRemoteChanged(projectId));

      for (const { result } of instances) {
        await waitFor(() => expect(result.current.entry).toEqual(GITHUB_ENTRY));
      }
    });

    it("unsubscribes on unmount", async () => {
      resolveProviderMock.mockResolvedValue({ entry: null, resolvedVia: null });
      const projectId = nextProjectId();

      const { unmount, result } = renderHook(() => useResolvedForgeProvider(projectId));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(remoteChangedCallbacks).toHaveLength(1);

      unmount();
      expect(remoteChangedCallbacks).toHaveLength(0);

      const callsAfterUnmount = resolveProviderMock.mock.calls.length;
      act(() => fireRemoteChanged(projectId));
      expect(resolveProviderMock.mock.calls.length).toBe(callsAfterUnmount);
    });
  });
});
