// @vitest-environment jsdom
import { StrictMode } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";
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

import {
  _resetResolvedForgeProviderForTesting,
  useResolvedForgeProvider,
} from "../useResolvedForgeProvider";
import { buildCacheKey, getCache, setCache } from "@/lib/forgeResourceCache";

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

  it("mirrors the code forge into the issues role when no issues provider is bound", async () => {
    // A pre-roles result: no `issues` half at all.
    resolveProviderMock.mockResolvedValue({ entry: GITHUB_ENTRY, resolvedVia: "hostname" });
    const projectId = nextProjectId();

    const { result } = renderHook(() => useResolvedForgeProvider(projectId));

    await waitFor(() => expect(result.current.issues.entry).toEqual(GITHUB_ENTRY));
    expect(result.current.issues.providerId).toBe("daintree.github.github");
    expect(result.current.issues.resolvedVia).toBe("code");
  });

  it("resolves a separately bound issues provider in the same round-trip (#13700)", async () => {
    const tracker: ForgeProviderEntry = {
      pluginId: "acme.tracker",
      contribution: { id: "tracker", name: "Tracker", matches: [], roles: ["issues"] },
    };
    resolveProviderMock.mockResolvedValue({
      entry: GITHUB_ENTRY,
      resolvedVia: "hostname",
      issues: { entry: tracker, resolvedVia: "override" },
    });
    const projectId = nextProjectId();

    const { result } = renderHook(() => useResolvedForgeProvider(projectId));

    await waitFor(() => expect(result.current.issues.providerId).toBe("acme.tracker.tracker"));
    expect(result.current.providerId).toBe("daintree.github.github");
    expect(result.current.issues.resolvedVia).toBe("override");
    expect(resolveProviderMock).toHaveBeenCalledTimes(1);
  });

  it("drops cached issue rows when the project's issues provider changes", async () => {
    const tracker: ForgeProviderEntry = {
      pluginId: "acme.tracker",
      contribution: { id: "tracker", name: "Tracker", matches: [], roles: ["issues"] },
    };
    resolveProviderMock.mockResolvedValue({ entry: GITHUB_ENTRY, resolvedVia: "hostname" });
    const projectId = nextProjectId();
    const { result } = renderHook(() => useResolvedForgeProvider(projectId));
    await waitFor(() => expect(result.current.issues.providerId).toBe("daintree.github.github"));

    const key = buildCacheKey("/repo", "issue", "open", "created");
    setCache(key, { items: [], nextCursor: null, hasMore: false, timestamp: Date.now() });
    resolveProviderMock.mockResolvedValue({
      entry: GITHUB_ENTRY,
      resolvedVia: "hostname",
      issues: { entry: tracker, resolvedVia: "override" },
    });
    act(() => fireRemoteChanged(projectId));

    await waitFor(() => expect(result.current.issues.providerId).toBe("acme.tracker.tracker"));
    expect(getCache(key)).toBeUndefined();
  });

  it("reports no issues provider when the bound one can't be served", async () => {
    resolveProviderMock.mockResolvedValue({
      entry: GITHUB_ENTRY,
      resolvedVia: "hostname",
      issues: { entry: null, resolvedVia: null },
    });
    const projectId = nextProjectId();

    const { result } = renderHook(() => useResolvedForgeProvider(projectId));

    await waitFor(() => expect(result.current.entry).toEqual(GITHUB_ENTRY));
    expect(result.current.issues).toEqual({ entry: null, providerId: null, resolvedVia: null });
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
    // Regression: Toolbar, ForgeStatsToolbarButton, ProjectDialogHost, and
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
      // Let go a microtask later, past StrictMode's replayed remount.
      await act(async () => {
        await Promise.resolve();
      });
      expect(remoteChangedCallbacks).toHaveLength(0);

      const callsAfterUnmount = resolveProviderMock.mock.calls.length;
      act(() => fireRemoteChanged(projectId));
      expect(resolveProviderMock.mock.calls.length).toBe(callsAfterUnmount);
    });
  });
  describe("request coalescing (#12042)", () => {
    // Each resolveProvider IPC reaches GitService.listRemotes in main, which
    // spawns `git remote -v`. Roughly ten components consume this hook, so an
    // uncoalesced fan-out pays one git process per consumer.

    it("collapses simultaneous consumers of one project into a single request", async () => {
      let release: (value: ResolvedForgeProvider) => void = () => {};
      resolveProviderMock.mockImplementation(
        () =>
          new Promise<ResolvedForgeProvider>((resolve) => {
            release = resolve;
          })
      );
      const projectId = nextProjectId();

      const consumers = Array.from({ length: 6 }, () =>
        renderHook(() => useResolvedForgeProvider(projectId))
      );
      expect(resolveProviderMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        release({ entry: GITHUB_ENTRY, resolvedVia: "hostname" });
      });

      // Coalescing must not cost anyone their answer.
      for (const consumer of consumers) {
        await waitFor(() => expect(consumer.result.current.entry).toEqual(GITHUB_ENTRY));
      }
    });

    it("collapses a provenance-change fan-out across every mounted consumer", async () => {
      // The larger of the two fan-outs: with a listener per consumer, a naive
      // "discard the in-flight request, then re-run" in every listener has each
      // one throwing away the request the previous listener started.
      resolveProviderMock.mockResolvedValue({ entry: GITHUB_ENTRY, resolvedVia: "hostname" });
      const projectId = nextProjectId();

      const consumers = Array.from({ length: 6 }, () =>
        renderHook(() => useResolvedForgeProvider(projectId))
      );
      await waitFor(() => expect(consumers[0]?.result.current.entry).toEqual(GITHUB_ENTRY));
      const callsBeforeEvent = resolveProviderMock.mock.calls.length;

      await act(async () => {
        fireProvenanceChanged();
      });

      expect(resolveProviderMock.mock.calls.length).toBe(callsBeforeEvent + 1);
      for (const consumer of consumers) {
        await waitFor(() => expect(consumer.result.current.entry).toEqual(GITHUB_ENTRY));
      }
    });

    it("collapses a remote-change fan-out across every mounted consumer", async () => {
      resolveProviderMock.mockResolvedValue({ entry: GITHUB_ENTRY, resolvedVia: "hostname" });
      const projectId = nextProjectId();

      const consumers = Array.from({ length: 6 }, () =>
        renderHook(() => useResolvedForgeProvider(projectId))
      );
      await waitFor(() => expect(consumers[0]?.result.current.entry).toEqual(GITHUB_ENTRY));
      const callsBeforeEvent = resolveProviderMock.mock.calls.length;

      await act(async () => {
        fireRemoteChanged(projectId);
      });

      expect(resolveProviderMock.mock.calls.length).toBe(callsBeforeEvent + 1);
    });

    it("invalidates again on the next event rather than once per session", async () => {
      // The burst marker must clear after the synchronous listener run, or the
      // second event would join the first event's now-stale request.
      resolveProviderMock.mockResolvedValue({ entry: GITHUB_ENTRY, resolvedVia: "hostname" });
      const projectId = nextProjectId();

      renderHook(() => useResolvedForgeProvider(projectId));
      await waitFor(() => expect(resolveProviderMock).toHaveBeenCalledTimes(1));

      await act(async () => {
        fireRemoteChanged(projectId);
      });
      const callsAfterFirstEvent = resolveProviderMock.mock.calls.length;

      await act(async () => {
        fireRemoteChanged(projectId);
      });

      expect(resolveProviderMock.mock.calls.length).toBeGreaterThan(callsAfterFirstEvent);
    });

    it("keeps different projects on their own requests", async () => {
      resolveProviderMock.mockResolvedValue({ entry: GITHUB_ENTRY, resolvedVia: "hostname" });
      const first = nextProjectId();
      const second = nextProjectId();

      renderHook(() => useResolvedForgeProvider(first));
      renderHook(() => useResolvedForgeProvider(second));

      await waitFor(() => expect(resolveProviderMock).toHaveBeenCalledTimes(2));
      expect(resolveProviderMock.mock.calls.map(([id]) => id)).toEqual([first, second]);
    });

    it("issues a fresh request after a remote change instead of joining the stale one", async () => {
      const pending: Array<(value: ResolvedForgeProvider) => void> = [];
      resolveProviderMock.mockImplementation(
        () => new Promise<ResolvedForgeProvider>((resolve) => pending.push(resolve))
      );
      const projectId = nextProjectId();

      const { result } = renderHook(() => useResolvedForgeProvider(projectId));
      expect(resolveProviderMock).toHaveBeenCalledTimes(1);

      // The remote changed while the first round-trip was still in flight; its
      // answer describes the repo as it was BEFORE the change.
      act(() => {
        fireRemoteChanged(projectId);
      });
      expect(resolveProviderMock).toHaveBeenCalledTimes(2);

      await act(async () => {
        pending[0]?.({ entry: null, resolvedVia: null });
        pending[1]?.({ entry: GITHUB_ENTRY, resolvedVia: "hostname" });
      });

      await waitFor(() => expect(result.current.entry).toEqual(GITHUB_ENTRY));
    });

    it("issues a fresh request after a provenance change", async () => {
      const pending: Array<(value: ResolvedForgeProvider) => void> = [];
      resolveProviderMock.mockImplementation(
        () => new Promise<ResolvedForgeProvider>((resolve) => pending.push(resolve))
      );
      const projectId = nextProjectId();

      renderHook(() => useResolvedForgeProvider(projectId));
      expect(resolveProviderMock).toHaveBeenCalledTimes(1);

      act(() => {
        fireProvenanceChanged();
      });

      expect(resolveProviderMock).toHaveBeenCalledTimes(2);
      await act(async () => {
        for (const resolve of pending) resolve({ entry: null, resolvedVia: null });
      });
    });

    it("does not wedge the coalescer when a request rejects", async () => {
      resolveProviderMock.mockRejectedValueOnce(new Error("bridge down"));
      const projectId = nextProjectId();

      const { result } = renderHook(() => useResolvedForgeProvider(projectId));
      await waitFor(() => expect(result.current.loading).toBe(false));

      resolveProviderMock.mockResolvedValue({ entry: GITHUB_ENTRY, resolvedVia: "hostname" });
      await act(async () => {
        result.current.refresh();
      });

      await waitFor(() => expect(result.current.entry).toEqual(GITHUB_ENTRY));
    });
  });

  describe("shared per-project state (#17072)", () => {
    // Every sidebar card mounts several consumers (its badges, its details), so
    // the listeners and the answer are shared rather than held per instance.

    it("holds one pair of invalidation listeners however many consumers mount", async () => {
      resolveProviderMock.mockResolvedValue({ entry: GITHUB_ENTRY, resolvedVia: "hostname" });
      const projectId = nextProjectId();
      const otherProjectId = nextProjectId();

      const consumers = [
        ...Array.from({ length: 5 }, () => renderHook(() => useResolvedForgeProvider(projectId))),
        renderHook(() => useResolvedForgeProvider(otherProjectId)),
      ];
      for (const { result } of consumers) {
        await waitFor(() => expect(result.current.entry).toEqual(GITHUB_ENTRY));
      }

      expect(provenanceCallbacks).toHaveLength(1);
      expect(remoteChangedCallbacks).toHaveLength(1);
      expect(resolveProviderMock.mock.calls.map(([id]) => id).sort()).toEqual(
        [projectId, otherProjectId].sort()
      );

      // The listeners stay while any consumer of any project does.
      for (const consumer of consumers.slice(0, 5)) consumer.unmount();
      expect(provenanceCallbacks).toHaveLength(1);
      consumers[5]!.unmount();
      await act(async () => {
        await Promise.resolve();
      });
      expect(provenanceCallbacks).toHaveLength(0);
      expect(remoteChangedCallbacks).toHaveLength(0);
    });

    it("asks once under StrictMode's replayed mount", async () => {
      resolveProviderMock.mockResolvedValue({ entry: GITHUB_ENTRY, resolvedVia: "hostname" });
      const projectId = nextProjectId();
      const { result } = renderHook(() => useResolvedForgeProvider(projectId), {
        wrapper: StrictMode,
      });
      await waitFor(() => expect(result.current.entry).toEqual(GITHUB_ENTRY));
      expect(resolveProviderMock).toHaveBeenCalledTimes(1);
      expect(provenanceCallbacks).toHaveLength(1);
    });

    // The stale answer can land before the remount (it must not be cached) or
    // after it (the remount must not have joined its request).
    it.each(["before", "after"] as const)(
      "never hands a remount a request that was out while nothing listened (answer lands %s)",
      async (landing) => {
        const releases: Array<(value: ResolvedForgeProvider) => void> = [];
        resolveProviderMock.mockImplementation(
          () =>
            new Promise<ResolvedForgeProvider>((resolve) => {
              releases.push(resolve);
            })
        );
        const projectId = nextProjectId();
        const first = renderHook(() => useResolvedForgeProvider(projectId));
        first.unmount();
        await act(async () => {
          await Promise.resolve();
        });
        expect(provenanceCallbacks).toHaveLength(0);

        // A plugin disable could have landed unheard while nothing listened.
        const releaseStale = () =>
          act(async () => {
            releases[0]!({ entry: GITHUB_ENTRY, resolvedVia: "hostname" });
          });
        if (landing === "before") await releaseStale();
        const second = renderHook(() => useResolvedForgeProvider(projectId));
        expect(resolveProviderMock).toHaveBeenCalledTimes(2);
        if (landing === "after") await releaseStale();
        expect(second.result.current.loading).toBe(true);
        expect(second.result.current.entry).toBeNull();

        await act(async () => {
          releases[1]!({ entry: null, resolvedVia: null });
        });
        expect(second.result.current.loading).toBe(false);
        expect(second.result.current.entry).toBeNull();
      }
    );

    it.each([
      ["a provenance change", "before"],
      ["a provenance change", "after"],
      ["a remote change", "before"],
      ["a remote change", "after"],
    ] as const)(
      "abandons an unwatched project's request on %s (answer lands %s the remount)",
      async (event, landing) => {
        const releases: Array<(value: ResolvedForgeProvider) => void> = [];
        resolveProviderMock.mockResolvedValueOnce({ entry: null, resolvedVia: null });
        const keepAliveId = nextProjectId();
        const keepAlive = renderHook(() => useResolvedForgeProvider(keepAliveId));
        await waitFor(() => expect(keepAlive.result.current.loading).toBe(false));

        resolveProviderMock.mockImplementation(
          () =>
            new Promise<ResolvedForgeProvider>((resolve) => {
              releases.push(resolve);
            })
        );
        const projectId = nextProjectId();
        renderHook(() => useResolvedForgeProvider(projectId)).unmount();
        act(() => {
          if (event === "a provenance change") fireProvenanceChanged();
          else fireRemoteChanged(projectId);
        });
        const releaseStale = () =>
          act(async () => {
            releases[0]!({ entry: GITHUB_ENTRY, resolvedVia: "hostname" });
          });
        if (landing === "before") await releaseStale();
        const callsBeforeRemount = resolveProviderMock.mock.calls.length;

        // The pre-change answer neither shows nor is joined.
        const remount = renderHook(() => useResolvedForgeProvider(projectId));
        expect(resolveProviderMock.mock.calls.length).toBe(callsBeforeRemount + 1);
        if (landing === "after") await releaseStale();
        expect(remount.result.current.loading).toBe(true);
        expect(remount.result.current.entry).toBeNull();
        keepAlive.unmount();
      }
    );

    it("invalidates a refresh's request on an event in a later task", async () => {
      resolveProviderMock.mockResolvedValue({ entry: null, resolvedVia: null });
      const projectId = nextProjectId();
      const { result } = renderHook(() => useResolvedForgeProvider(projectId));
      await waitFor(() => expect(result.current.loading).toBe(false));

      const releases: Array<(value: ResolvedForgeProvider) => void> = [];
      resolveProviderMock.mockImplementation(
        () =>
          new Promise<ResolvedForgeProvider>((resolve) => {
            releases.push(resolve);
          })
      );
      act(() => result.current.refresh());
      await act(async () => {
        await Promise.resolve();
      });
      const callsBeforeEvent = resolveProviderMock.mock.calls.length;

      // The refresh's burst is over: the event must not join its request.
      act(() => fireProvenanceChanged());
      expect(resolveProviderMock.mock.calls.length).toBe(callsBeforeEvent + 1);
      await act(async () => {
        releases[1]!({ entry: null, resolvedVia: null });
      });
      await act(async () => {
        releases[0]!({ entry: GITHUB_ENTRY, resolvedVia: "hostname" });
      });
      expect(result.current.entry).toBeNull();
    });

    it.each([
      ["a provenance change, then a refresh", true],
      ["a refresh, then a provenance change", false],
    ])("shares one fresh request for %s in one burst", async (_label, eventFirst) => {
      resolveProviderMock.mockResolvedValue({ entry: null, resolvedVia: null });
      const projectId = nextProjectId();
      const { result } = renderHook(() => useResolvedForgeProvider(projectId));
      await waitFor(() => expect(result.current.loading).toBe(false));
      const callsBefore = resolveProviderMock.mock.calls.length;

      resolveProviderMock.mockResolvedValue({ entry: GITHUB_ENTRY, resolvedVia: "hostname" });
      act(() => {
        if (eventFirst) fireProvenanceChanged();
        result.current.refresh();
        if (!eventFirst) fireProvenanceChanged();
      });

      expect(resolveProviderMock.mock.calls.length).toBe(callsBefore + 1);
      await waitFor(() => expect(result.current.entry).toEqual(GITHUB_ENTRY));
    });

    it("serves a consumer mounting beside a live one without another request", async () => {
      resolveProviderMock.mockResolvedValue({ entry: GITHUB_ENTRY, resolvedVia: "hostname" });
      const projectId = nextProjectId();

      const first = renderHook(() => useResolvedForgeProvider(projectId));
      await waitFor(() => expect(first.result.current.entry).toEqual(GITHUB_ENTRY));

      const second = renderHook(() => useResolvedForgeProvider(projectId));
      await act(async () => {
        await Promise.resolve();
      });
      expect(second.result.current.entry).toEqual(GITHUB_ENTRY);
      expect(resolveProviderMock).toHaveBeenCalledTimes(1);
    });

    it("asks again once a project's last consumer has left and another mounts", async () => {
      resolveProviderMock.mockResolvedValue({ entry: null, resolvedVia: null });
      const projectId = nextProjectId();

      const first = renderHook(() => useResolvedForgeProvider(projectId));
      await waitFor(() => expect(first.result.current.loading).toBe(false));
      first.unmount();

      // Unheard while nothing listened: the remount must not trust the cache.
      resolveProviderMock.mockResolvedValue({ entry: GITHUB_ENTRY, resolvedVia: "hostname" });
      const second = renderHook(() => useResolvedForgeProvider(projectId));
      expect(second.result.current.loading).toBe(false);
      await waitFor(() => expect(second.result.current.entry).toEqual(GITHUB_ENTRY));
      expect(resolveProviderMock).toHaveBeenCalledTimes(2);
    });

    it("keeps a live project's answer through an invalidation until the new one lands", async () => {
      resolveProviderMock.mockResolvedValue({ entry: GITHUB_ENTRY, resolvedVia: "hostname" });
      const projectId = nextProjectId();
      const { result } = renderHook(() => useResolvedForgeProvider(projectId));
      await waitFor(() => expect(result.current.entry).toEqual(GITHUB_ENTRY));

      let release: (value: ResolvedForgeProvider) => void = () => {};
      resolveProviderMock.mockImplementation(
        () =>
          new Promise<ResolvedForgeProvider>((resolve) => {
            release = resolve;
          })
      );
      act(() => fireProvenanceChanged());
      expect(result.current.loading).toBe(false);
      expect(result.current.entry).toEqual(GITHUB_ENTRY);
      // A consumer mounting mid-invalidation sees what its siblings show.
      const late = renderHook(() => useResolvedForgeProvider(projectId));
      expect(late.result.current.loading).toBe(false);
      expect(late.result.current.entry).toEqual(GITHUB_ENTRY);

      await act(async () => {
        release({ entry: null, resolvedVia: null });
      });
      expect(result.current.entry).toBeNull();
      expect(late.result.current.entry).toBeNull();
    });

    it("drops an unmounted project's answer on a provenance change", async () => {
      resolveProviderMock.mockResolvedValue({ entry: GITHUB_ENTRY, resolvedVia: "hostname" });
      const projectId = nextProjectId();
      const keepAliveId = nextProjectId();
      const keepAlive = renderHook(() => useResolvedForgeProvider(keepAliveId));
      const gone = renderHook(() => useResolvedForgeProvider(projectId));
      await waitFor(() => expect(gone.result.current.entry).toEqual(GITHUB_ENTRY));
      gone.unmount();

      act(() => fireProvenanceChanged());

      // No stale provider from before an enable/disable nothing was showing.
      resolveProviderMock.mockImplementation(() => new Promise(() => {}));
      const remount = renderHook(() => useResolvedForgeProvider(projectId));
      expect(remount.result.current.loading).toBe(true);
      expect(remount.result.current.entry).toBeNull();
      keepAlive.unmount();
    });

    it("hands a refresh's answer to every consumer of the project", async () => {
      resolveProviderMock.mockResolvedValue({ entry: null, resolvedVia: null });
      const projectId = nextProjectId();
      const consumers = Array.from({ length: 3 }, () =>
        renderHook(() => useResolvedForgeProvider(projectId))
      );
      for (const { result } of consumers) {
        await waitFor(() => expect(result.current.loading).toBe(false));
      }

      resolveProviderMock.mockResolvedValue({ entry: GITHUB_ENTRY, resolvedVia: "hostname" });
      await act(async () => {
        consumers[0]!.result.current.refresh();
      });

      for (const { result } of consumers) {
        await waitFor(() => expect(result.current.entry).toEqual(GITHUB_ENTRY));
      }
      expect(resolveProviderMock).toHaveBeenCalledTimes(2);
    });

    it("switches to the new project's answer on the render the id changes", async () => {
      const projectA = nextProjectId();
      const projectB = nextProjectId();
      resolveProviderMock.mockResolvedValue({ entry: GITHUB_ENTRY, resolvedVia: "hostname" });
      const warmB = renderHook(() => useResolvedForgeProvider(projectB));
      await waitFor(() => expect(warmB.result.current.entry).toEqual(GITHUB_ENTRY));

      resolveProviderMock.mockResolvedValue({ entry: null, resolvedVia: null });
      const seen: Array<{ id: string; providerId: string | null }> = [];
      const { result, rerender } = renderHook(
        ({ id }) => {
          const state = useResolvedForgeProvider(id);
          seen.push({ id, providerId: state.providerId });
          return state;
        },
        { initialProps: { id: projectA } }
      );
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.entry).toBeNull();

      // Never the outgoing project's provider under the incoming id, not even
      // for the one render before an effect could catch up.
      seen.length = 0;
      rerender({ id: projectB });
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((render) => render.id === projectB)).toBe(true);
      expect(seen.every((render) => render.providerId === "daintree.github.github")).toBe(true);
      warmB.unmount();
    });

    it.each(["before", "after"] as const)(
      "forgets settled answers and requests still out on reset (stale answer lands %s)",
      async (landing) => {
        resolveProviderMock.mockResolvedValue({ entry: GITHUB_ENTRY, resolvedVia: "hostname" });
        const projectId = nextProjectId();
        const pendingProjectId = nextProjectId();
        const first = renderHook(() => useResolvedForgeProvider(projectId));
        await waitFor(() => expect(first.result.current.entry).toEqual(GITHUB_ENTRY));

        let releaseStale: (value: ResolvedForgeProvider) => void = () => {};
        resolveProviderMock.mockImplementationOnce(
          () =>
            new Promise<ResolvedForgeProvider>((resolve) => {
              releaseStale = resolve;
            })
        );
        renderHook(() => useResolvedForgeProvider(pendingProjectId));
        cleanup();
        _resetResolvedForgeProviderForTesting();

        resolveProviderMock.mockImplementation(() => new Promise(() => {}));
        const second = renderHook(() => useResolvedForgeProvider(projectId));
        expect(second.result.current.loading).toBe(true);
        expect(provenanceCallbacks).toHaveLength(1);

        // A response from before the reset neither answers nor is joined by a
        // consumer after it.
        const settleStale = () =>
          act(async () => {
            releaseStale({ entry: GITHUB_ENTRY, resolvedVia: "hostname" });
          });
        if (landing === "before") await settleStale();
        const callsBefore = resolveProviderMock.mock.calls.length;
        const pending = renderHook(() => useResolvedForgeProvider(pendingProjectId));
        expect(resolveProviderMock.mock.calls.length).toBe(callsBefore + 1);
        if (landing === "after") await settleStale();
        expect(pending.result.current.loading).toBe(true);
        expect(pending.result.current.entry).toBeNull();
      }
    );
  });
});
