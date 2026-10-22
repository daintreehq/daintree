// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { usePanelStore } from "@/store/panelStore";
import type {
  PluginSearchProviderInfo,
  PluginSearchQueryRequest,
  PluginSearchQueryResponse,
} from "@shared/types/plugin";

const { useWorktreeStoreMock, openHitMock } = vi.hoisted(() => ({
  useWorktreeStoreMock: vi.fn(),
  openHitMock: vi.fn(),
}));

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: useWorktreeStoreMock,
}));

vi.mock("@/components/QuickSwitcher/openPluginSearchHit", () => ({
  openPluginSearchHit: openHitMock,
}));

vi.mock("@/store", async () => {
  const actual = await vi.importActual<typeof import("@/store")>("@/store");
  return {
    ...actual,
    useWorktreeSelectionStore: Object.assign(
      (selector: (s: unknown) => unknown) =>
        selector({ selectWorktree: vi.fn(), activeWorktreeId: null }),
      { getState: () => ({ activeWorktreeId: null }) }
    ),
  };
});

import { useQuickSwitcher } from "../useQuickSwitcher";
import { usePaletteStore } from "@/store/paletteStore";

function provider(overrides: Partial<PluginSearchProviderInfo> = {}): PluginSearchProviderInfo {
  return {
    key: "acme.notes.notes",
    pluginId: "acme.notes",
    pluginName: "Acme Notes",
    title: "Notes",
    keyword: "notes",
    iconId: "notebook",
    blend: true,
    kind: "declarative",
    shown: true,
    ...overrides,
  };
}

function row(id: string, label: string) {
  return {
    id,
    label,
    iconId: "notebook",
    target: { type: "panel" as const, panelKindId: "acme.notes.notes", args: { id } },
  };
}

interface PendingQuery {
  request: PluginSearchQueryRequest;
  resolve: (response: PluginSearchQueryResponse) => void;
}

let pending: PendingQuery[];
let catalog: PluginSearchProviderInfo[];
const bridge = {
  getSearchProviders: vi.fn(async () => catalog),
  querySearchProvider: vi.fn(
    (request: PluginSearchQueryRequest) =>
      new Promise<PluginSearchQueryResponse>((resolve) => pending.push({ request, resolve }))
  ),
  cancelSearchProviders: vi.fn(async () => {}),
};

async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function openSwitcher() {
  const hook = renderHook(() => useQuickSwitcher());
  act(() => hook.result.current.open());
  await settle();
  return hook;
}

beforeEach(() => {
  vi.useFakeTimers();
  pending = [];
  catalog = [provider()];
  bridge.getSearchProviders.mockClear();
  bridge.querySearchProvider.mockClear();
  bridge.cancelSearchProviders.mockClear();
  openHitMock.mockClear();
  vi.stubGlobal("electron", { plugin: bridge });
  useWorktreeStoreMock.mockImplementation((selector: (s: unknown) => unknown) =>
    selector({
      worktrees: new Map(),
      isLoading: false,
      isInitialized: true,
      isReconnecting: false,
      error: null,
    })
  );
  usePanelStore.setState({
    panelsById: {
      "t-1": {
        id: "t-1",
        title: "Groceries shell",
        kind: "terminal",
        cwd: "/g",
        cols: 80,
        rows: 24,
        location: "grid",
      },
    },
    panelIds: ["t-1"],
    mruList: [],
  });
});

afterEach(() => {
  usePaletteStore.setState({ activePaletteId: null });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useQuickSwitcher plugin search providers", () => {
  it("appends blended rows below the built-in ones once the provider answers", async () => {
    const { result } = await openSwitcher();
    act(() => result.current.setQuery("groc"));
    expect(bridge.querySearchProvider).not.toHaveBeenCalled();

    await settle(150);
    expect(pending.map((p) => p.request)).toEqual([
      { providerKey: "acme.notes.notes", query: "groc", mode: "blended" },
    ]);
    const builtIn = result.current.results.map((item) => item.id);
    expect(builtIn).toEqual(["terminal:t-1"]);

    await act(async () => pending[0]!.resolve({ status: "ok", results: [row("n1", "Groceries")] }));
    expect(result.current.results.map((item) => item.id)).toEqual([
      "terminal:t-1",
      "plugin:acme.notes.notes:n1",
    ]);
    expect(result.current.selectedIndex).toBe(0);
  });

  it("drops rows from an earlier query the moment the input changes", async () => {
    const { result } = await openSwitcher();
    act(() => result.current.setQuery("groc"));
    await settle(150);
    await act(async () => pending[0]!.resolve({ status: "ok", results: [row("n1", "Groceries")] }));
    expect(result.current.results.some((item) => item.type === "plugin")).toBe(true);

    act(() => result.current.setQuery("groce"));
    expect(result.current.results.some((item) => item.type === "plugin")).toBe(false);
  });

  it("cancels a query still in flight when the input changes, and ignores its late answer", async () => {
    const { result } = await openSwitcher();
    act(() => result.current.setQuery("groc"));
    await settle(150);
    act(() => result.current.setQuery("groce"));
    expect(bridge.cancelSearchProviders).toHaveBeenCalledTimes(1);

    await act(async () => pending[0]!.resolve({ status: "ok", results: [row("old", "Old")] }));
    expect(result.current.results.some((item) => item.id.endsWith(":old"))).toBe(false);
    await settle(150);
    expect(pending.at(-1)!.request.query).toBe("groce");
  });

  it("asks nothing for an empty query or a provider that doesn't blend", async () => {
    catalog = [provider({ blend: false })];
    const { result } = await openSwitcher();
    await settle(150);
    act(() => result.current.setQuery("groc"));
    await settle(150);
    expect(bridge.querySearchProvider).not.toHaveBeenCalled();
  });

  it("leaves out providers the user turned off or whose keyword another plugin holds", async () => {
    catalog = [
      provider({ shown: false }),
      provider({ key: "other.notes.notes", pluginId: "other.notes", keywordTakenBy: "Acme" }),
    ];
    const { result } = await openSwitcher();
    act(() => result.current.setQuery("notes"));
    expect(result.current.keywordProvider).toBeNull();
    await settle(150);
    expect(bridge.querySearchProvider).not.toHaveBeenCalled();
  });

  it("scopes to a provider by keyword, listing only its rows", async () => {
    const { result } = await openSwitcher();
    act(() => result.current.setQuery("notes"));
    expect(result.current.keywordProvider?.key).toBe("acme.notes.notes");

    act(() => result.current.enterScope("acme.notes.notes"));
    expect(result.current.query).toBe("");
    expect(result.current.scopedProvider?.title).toBe("Notes");
    expect(result.current.scopedStatus).toBe("loading");
    expect(result.current.results).toEqual([]);

    await settle(150);
    const scoped = pending.at(-1)!;
    expect(scoped.request).toEqual({
      providerKey: "acme.notes.notes",
      query: "",
      mode: "scoped",
    });
    await act(async () =>
      scoped.resolve({ status: "ok", results: [row("n1", "Groceries"), row("n2", "Trip")] })
    );
    expect(result.current.scopedStatus).toBe("done");
    expect(result.current.results.map((item) => item.title)).toEqual(["Groceries", "Trip"]);

    act(() => result.current.exitScope());
    expect(result.current.scopedProvider).toBeNull();
  });

  it("reports a scoped provider that missed its deadline", async () => {
    const { result } = await openSwitcher();
    act(() => result.current.enterScope("acme.notes.notes"));
    await settle(150);
    await act(async () => pending.at(-1)!.resolve({ status: "timeout" }));
    expect(result.current.scopedStatus).toBe("timeout");
    expect(result.current.isLoading).toBe(false);
  });

  it("opens a picked plugin row and closes", async () => {
    const { result } = await openSwitcher();
    act(() => result.current.enterScope("acme.notes.notes"));
    await settle(150);
    await act(async () =>
      pending.at(-1)!.resolve({ status: "ok", results: [row("n1", "Groceries")] })
    );
    act(() => result.current.confirmSelection());
    expect(openHitMock).toHaveBeenCalledWith(
      expect.objectContaining({ providerKey: "acme.notes.notes", row: row("n1", "Groceries") })
    );
    expect(usePaletteStore.getState().activePaletteId).toBeNull();
  });

  it("drops the scope and cancels in-flight queries when the switcher closes", async () => {
    const { result } = await openSwitcher();
    act(() => result.current.enterScope("acme.notes.notes"));
    await settle(150);
    act(() => result.current.close());
    await settle();
    expect(bridge.cancelSearchProviders).toHaveBeenCalled();

    act(() => result.current.open());
    await settle();
    expect(result.current.scopedProvider).toBeNull();
  });

  it("never opens a plugin row picked after the query moved on", async () => {
    const { result } = await openSwitcher();
    act(() => result.current.setQuery("groc"));
    await settle(150);
    await act(async () => pending[0]!.resolve({ status: "ok", results: [row("n1", "Groceries")] }));
    const stale = result.current.results.find((item) => item.type === "plugin")!;

    act(() => result.current.setQuery("trip"));
    // A click on a row the list still showed a render ago.
    act(() => result.current.selectItem(stale));
    expect(openHitMock).not.toHaveBeenCalled();
    expect(usePaletteStore.getState().activePaletteId).toBe("quick-switcher");
  });

  it("doesn't bring back an earlier answer when the query returns to it", async () => {
    const { result } = await openSwitcher();
    act(() => result.current.setQuery("groc"));
    await settle(150);
    await act(async () => pending[0]!.resolve({ status: "ok", results: [row("n1", "Groceries")] }));

    act(() => result.current.setQuery("gro"));
    act(() => result.current.setQuery("groc"));
    expect(result.current.results.some((item) => item.type === "plugin")).toBe(false);

    await settle(150);
    await act(async () =>
      pending.at(-1)!.resolve({ status: "ok", results: [row("n2", "Grocery run")] })
    );
    expect(
      result.current.results.filter((item) => item.type === "plugin").map((i) => i.title)
    ).toEqual(["Grocery run"]);
  });

  it("keeps an answer when a reopened switcher's catalog read lands later unchanged", async () => {
    const { result } = await openSwitcher();
    act(() => result.current.close());
    await settle();

    let releaseCatalog!: (list: PluginSearchProviderInfo[]) => void;
    bridge.getSearchProviders.mockImplementationOnce(
      () =>
        new Promise<PluginSearchProviderInfo[]>((resolve) => {
          releaseCatalog = resolve;
        })
    );
    act(() => result.current.open());
    act(() => result.current.setQuery("groc"));
    await settle(150);
    await act(async () =>
      pending.at(-1)!.resolve({ status: "ok", results: [row("n1", "Groceries")] })
    );
    const asked = bridge.querySearchProvider.mock.calls.length;

    await act(async () => releaseCatalog([provider()]));
    await settle(150);
    expect(result.current.results.some((item) => item.id.endsWith(":n1"))).toBe(true);
    expect(bridge.querySearchProvider.mock.calls.length).toBe(asked);
  });
});
