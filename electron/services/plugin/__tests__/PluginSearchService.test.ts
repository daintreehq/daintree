import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginSearchResultTarget } from "../../../../shared/types/plugin.js";
import { SEARCH_RESULT_ARGS_MAX_BYTES } from "../../../../shared/config/pluginSearchProviders.js";

const { projectOf } = vi.hoisted(() => ({ projectOf: new Map<string, string | null>() }));

// Scope routing is the broadcaster's; here a plugin is either installed (seen
// by every project) or owned by one project.
vi.mock("../PluginContributionBroadcaster.js", () => ({
  selectContributionsForProject: <T>(
    items: readonly T[],
    pluginIdOf: (item: T) => string | undefined,
    projectId: string | null | undefined
  ) =>
    items.filter((item) => {
      const owner = projectOf.get(pluginIdOf(item) ?? "") ?? null;
      return owner === null || owner === projectId;
    }),
}));

import {
  bindSearchProviderImpl,
  clearSearchProviderRegistry,
  registerSearchProviders,
  unregisterSearchProviders,
  type RegisteredSearchProvider,
} from "../pluginSearchProviderRegistry.js";
import {
  PluginSearchCoordinator,
  declarativeRowsToResults,
  listSearchProviders,
  validateSearchResults,
  type PluginSearchDeps,
} from "../PluginSearchService.js";

function provider(overrides: Partial<RegisteredSearchProvider> = {}): RegisteredSearchProvider {
  const pluginId = overrides.pluginId ?? "acme.notes";
  const providerId = overrides.providerId ?? "notes";
  return {
    key: `${pluginId}.${providerId}`,
    pluginId,
    providerId,
    pluginName: overrides.pluginName ?? "Acme Notes",
    title: "Notes",
    keyword: "notes",
    iconId: "notebook",
    blend: true,
    kind: "runtime",
    projectId: projectOf.get(pluginId) ?? null,
    defaultTarget: { panel: "notes" },
    resolveTarget: (target: PluginSearchResultTarget, args: Record<string, unknown>) => {
      if (target.panel === "notes") {
        return { type: "panel", panelKindId: `${pluginId}.notes`, args };
      }
      if (target.command === `${pluginId}.open`) {
        return { type: "command", actionId: target.command, args };
      }
      return null;
    },
    resolveResultIcon: (iconId: string) => (iconId === "star" ? "star" : undefined),
    ...overrides,
  };
}

function endpoint(id = "view-1") {
  const closers: Array<() => void> = [];
  return {
    endpointId: id,
    onClose: (cb: () => void) => {
      closers.push(cb);
      return { dispose: () => {} };
    },
    close: () => closers.forEach((cb) => cb()),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let hidden: Set<string>;
let diagnostics: Array<{ pluginId: string; message: string }>;
let activatePlugin: ReturnType<typeof vi.fn<PluginSearchDeps["activatePlugin"]>>;

function coordinator(overrides: Partial<PluginSearchDeps> = {}) {
  return new PluginSearchCoordinator({
    activatePlugin,
    recordDiagnostic: (pluginId, message) => diagnostics.push({ pluginId, message }),
    hiddenProviderKeys: () => hidden,
    ...overrides,
  });
}

beforeEach(() => {
  clearSearchProviderRegistry();
  projectOf.clear();
  hidden = new Set();
  diagnostics = [];
  activatePlugin = vi.fn<PluginSearchDeps["activatePlugin"]>(async () => {});
});

afterEach(() => {
  vi.useRealTimers();
});

describe("search provider registry", () => {
  it("reports a keyword another plugin registered first wherever both can be seen", () => {
    projectOf.set("project__p1__acme.wiki", "p1");
    projectOf.set("project__p2__acme.docs", "p2");
    registerSearchProviders("acme.notes", [provider()]);

    const installed = registerSearchProviders("other.notes", [
      provider({ pluginId: "other.notes", pluginName: "Other Notes" }),
    ]);
    expect(installed.map((c) => c.takenBy.pluginId)).toEqual(["acme.notes"]);

    const inProject = registerSearchProviders("project__p1__acme.wiki", [
      provider({ pluginId: "project__p1__acme.wiki", keyword: "wiki" }),
    ]);
    expect(inProject).toEqual([]);

    // Two project plugins in different projects never share an audience.
    registerSearchProviders("project__p1__acme.wiki", [
      provider({ pluginId: "project__p1__acme.wiki", keyword: "docs" }),
    ]);
    const otherProject = registerSearchProviders("project__p2__acme.docs", [
      provider({ pluginId: "project__p2__acme.docs", keyword: "docs" }),
    ]);
    expect(otherProject).toEqual([]);
  });

  it("refuses the later provider per project and keeps the first's claim across its reload", () => {
    registerSearchProviders("acme.notes", [provider()]);
    registerSearchProviders("other.notes", [
      provider({ pluginId: "other.notes", pluginName: "Other Notes" }),
    ]);
    // The keyword holder reloads: it keeps its place rather than losing the
    // keyword to the plugin that was refused.
    unregisterSearchProviders("acme.notes");
    registerSearchProviders("acme.notes", [provider()]);

    const listed = listSearchProviders("p1", new Set());
    expect(listed.find((p) => p.pluginId === "acme.notes")?.keywordTakenBy).toBeUndefined();
    expect(listed.find((p) => p.pluginId === "other.notes")?.keywordTakenBy).toBe("Acme Notes");
  });

  it("lists only what the project can see, with the user's choice", () => {
    projectOf.set("project__p1__acme.wiki", "p1");
    registerSearchProviders("acme.notes", [provider()]);
    registerSearchProviders("project__p1__acme.wiki", [
      provider({ pluginId: "project__p1__acme.wiki", keyword: "wiki" }),
    ]);
    hidden.add("acme.notes.notes");

    expect(listSearchProviders("p2", hidden).map((p) => [p.key, p.shown])).toEqual([
      ["acme.notes.notes", false],
    ]);
    expect(listSearchProviders("p1", hidden).map((p) => p.key)).toEqual([
      "acme.notes.notes",
      "project__p1__acme.wiki.notes",
    ]);
  });

  it("binds only a declared runtime provider, and a stale disposer leaves its replacement", () => {
    registerSearchProviders("acme.notes", [
      provider(),
      provider({ providerId: "db", keyword: "db", kind: "declarative" }),
    ]);
    expect(() => bindSearchProviderImpl("acme.notes.db", () => [])).toThrow(/no runtime/);
    expect(() => bindSearchProviderImpl("acme.notes.missing", () => [])).toThrow(/no runtime/);

    const first = vi.fn(() => []);
    const second = vi.fn(() => []);
    const disposeFirst = bindSearchProviderImpl("acme.notes.notes", first);
    bindSearchProviderImpl("acme.notes.notes", second);
    disposeFirst();
    return coordinator()
      .query(endpoint(), "p1", { providerKey: "acme.notes.notes", query: "x", mode: "blended" })
      .then(() => {
        expect(second).toHaveBeenCalledTimes(1);
        expect(first).not.toHaveBeenCalled();
      });
  });
});

describe("PluginSearchCoordinator", () => {
  it("never wakes a plugin for a blended search", async () => {
    registerSearchProviders("acme.notes", [provider()]);
    const result = await coordinator().query(endpoint(), "p1", {
      providerKey: "acme.notes.notes",
      query: "gro",
      mode: "blended",
    });
    expect(result).toEqual({ status: "unavailable" });
    expect(activatePlugin).not.toHaveBeenCalled();
  });

  it("starts the plugin for a scoped search and asks what it bound", async () => {
    registerSearchProviders("acme.notes", [provider({ blend: false })]);
    const impl = vi.fn(() => [{ id: "n1", label: "Groceries" }]);
    activatePlugin.mockImplementation(async () => {
      bindSearchProviderImpl("acme.notes.notes", impl);
    });
    const result = await coordinator().query(endpoint(), "p1", {
      providerKey: "acme.notes.notes",
      query: "  gro  ",
      mode: "scoped",
    });
    expect(activatePlugin).toHaveBeenCalledWith("acme.notes");
    expect(impl).toHaveBeenCalledWith(
      "gro",
      expect.objectContaining({ mode: "scoped", limit: 20 })
    );
    expect(result).toEqual({
      status: "ok",
      results: [
        {
          id: "n1",
          label: "Groceries",
          iconId: "notebook",
          target: { type: "panel", panelKindId: "acme.notes.notes", args: {} },
        },
      ],
    });
  });

  it("records a provider that bound nothing after activating", async () => {
    registerSearchProviders("acme.notes", [provider()]);
    const result = await coordinator().query(endpoint(), "p1", {
      providerKey: "acme.notes.notes",
      query: "gro",
      mode: "scoped",
    });
    expect(result).toEqual({ status: "error" });
    expect(diagnostics[0]?.message).toMatch(/registerSearchProvider/);
  });

  it.each([
    ["switched off", () => hidden.add("acme.notes.notes"), "scoped"],
    ["blend-less, for a blended search", () => {}, "blended"],
  ] as const)("answers unavailable for a provider %s", async (_label, arrange, mode) => {
    registerSearchProviders("acme.notes", [provider({ blend: false })]);
    bindSearchProviderImpl("acme.notes.notes", () => [{ id: "n1", label: "x" }]);
    arrange();
    const result = await coordinator().query(endpoint(), "p1", {
      providerKey: "acme.notes.notes",
      query: "x",
      mode,
    });
    expect(result).toEqual({ status: "unavailable" });
  });

  it("refuses a provider whose keyword another plugin holds, and one the project can't see", async () => {
    projectOf.set("project__p2__acme.wiki", "p2");
    registerSearchProviders("acme.notes", [provider()]);
    registerSearchProviders("other.notes", [provider({ pluginId: "other.notes" })]);
    registerSearchProviders("project__p2__acme.wiki", [
      provider({ pluginId: "project__p2__acme.wiki", keyword: "wiki" }),
    ]);
    for (const key of ["other.notes.notes", "project__p2__acme.wiki.notes"]) {
      bindSearchProviderImpl(key, () => [{ id: "n1", label: "x" }]);
      const result = await coordinator().query(endpoint(), "p1", {
        providerKey: key,
        query: "x",
        mode: "scoped",
      });
      expect(result).toEqual({ status: "unavailable" });
    }
  });

  it("drops a provider that misses its deadline and records it once per window", async () => {
    vi.useFakeTimers();
    registerSearchProviders("acme.notes", [provider()]);
    bindSearchProviderImpl("acme.notes.notes", () => new Promise(() => {}));
    let now = 0;
    const search = coordinator({ deadlineMs: 1000, now: () => now });
    const ask = () =>
      search.query(endpoint(), "p1", {
        providerKey: "acme.notes.notes",
        query: "x",
        mode: "blended",
      });

    const first = ask();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await first).toEqual({ status: "timeout" });
    now = 10_000;
    const second = ask();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await second).toEqual({ status: "timeout" });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ pluginId: "acme.notes" });
    expect(diagnostics[0]?.message).toMatch(/didn't answer within 1000 ms/);
  });

  it("lets the latest query to a provider win and aborts the one before it", async () => {
    registerSearchProviders("acme.notes", [provider()]);
    const pending = deferred<{ id: string; label: string }[]>();
    const signals: AbortSignal[] = [];
    bindSearchProviderImpl("acme.notes.notes", (query, context) => {
      signals.push(context.signal);
      return query === "a" ? pending.promise : [{ id: "ab", label: "AB" }];
    });
    const search = coordinator();
    const view = endpoint();
    const first = search.query(view, "p1", {
      providerKey: "acme.notes.notes",
      query: "a",
      mode: "blended",
    });
    const second = search.query(view, "p1", {
      providerKey: "acme.notes.notes",
      query: "ab",
      mode: "blended",
    });
    expect(await first).toEqual({ status: "cancelled" });
    expect(signals[0]?.aborted).toBe(true);
    expect((await second).status).toBe("ok");
    pending.resolve([{ id: "late", label: "Late" }]);
    expect(diagnostics).toEqual([]);
  });

  it("cancels a view's queries on request and when the view goes away", async () => {
    registerSearchProviders("acme.notes", [provider()]);
    bindSearchProviderImpl("acme.notes.notes", () => new Promise(() => {}));
    const search = coordinator();
    const view = endpoint();
    const ask = () =>
      search.query(view, "p1", { providerKey: "acme.notes.notes", query: "x", mode: "blended" });

    const cancelled = ask();
    search.cancel(view.endpointId);
    expect(await cancelled).toEqual({ status: "cancelled" });

    const closed = ask();
    view.close();
    expect(await closed).toEqual({ status: "cancelled" });
  });

  it("answers a declarative provider from its query rows", async () => {
    const runDeclarative = vi.fn(async () => ({
      columns: ["id", "label", "description", "args"],
      rows: [
        [1, "Groceries", "Shopping list", '{"noteId":1}'],
        [2, "Trip", null, "not json"],
      ],
    }));
    registerSearchProviders("acme.notes", [provider({ kind: "declarative", runDeclarative })]);
    const result = await coordinator().query(endpoint(), "p1", {
      providerKey: "acme.notes.notes",
      query: "gro",
      mode: "blended",
    });
    expect(runDeclarative).toHaveBeenCalledWith("gro", 3, expect.any(AbortSignal));
    expect(activatePlugin).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "ok",
      results: [
        {
          id: "1",
          label: "Groceries",
          description: "Shopping list",
          iconId: "notebook",
          target: { type: "panel", panelKindId: "acme.notes.notes", args: { noteId: 1 } },
        },
      ],
    });
    expect(diagnostics[0]?.message).toMatch(/1 result the quick switcher can't show/);
  });

  it("records a declarative query that returns no id and label columns", async () => {
    registerSearchProviders("acme.notes", [
      provider({
        kind: "declarative",
        runDeclarative: async () => ({ columns: ["title"], rows: [["Groceries"]] }),
      }),
    ]);
    const result = await coordinator().query(endpoint(), "p1", {
      providerKey: "acme.notes.notes",
      query: "gro",
      mode: "scoped",
    });
    expect(result).toEqual({ status: "error" });
    expect(diagnostics[0]?.message).toMatch(/"id" and "label" columns/);
  });
});

describe("validateSearchResults", () => {
  it("keeps only rows the switcher may show and open", () => {
    const p = provider();
    const { rows, dropped } = validateSearchResults(
      p,
      [
        { id: "ok", label: "  Groceries  ", iconId: "star", args: { noteId: 1 } },
        { id: "cmd", label: "Run", target: { command: "acme.notes.open" } },
        { id: "foreign", label: "Elsewhere", target: { command: "other.plugin.open" } },
        { id: "no-label", label: "   " },
        { id: "ok", label: "Duplicate id" },
        { id: "big", label: "Big", args: { blob: "x".repeat(SEARCH_RESULT_ARGS_MAX_BYTES) } },
        { id: "array-args", label: "Array", args: [1, 2] },
        { label: "No id" },
        "not an object",
      ],
      20
    );
    expect(rows.map((row) => row.id)).toEqual(["ok", "cmd"]);
    expect(rows[0]).toMatchObject({ label: "Groceries", iconId: "star" });
    expect(rows[1]).toMatchObject({
      iconId: "notebook",
      target: { type: "command", actionId: "acme.notes.open", args: {} },
    });
    expect(dropped).toBe(7);
  });

  it("cuts a long label and stops at the limit", () => {
    const { rows } = validateSearchResults(
      provider(),
      [
        { id: "a", label: "x".repeat(500) },
        { id: "b", label: "B" },
      ],
      1
    );
    expect(rows).toHaveLength(1);
    expect(Array.from(rows[0]!.label).length).toBeLessThan(500);
    expect(rows[0]!.label.endsWith("…")).toBe(true);
  });

  it("drops an answer that isn't a list", () => {
    expect(validateSearchResults(provider(), { id: "x" }, 20)).toEqual({ rows: [], dropped: 1 });
  });
});

describe("declarativeRowsToResults", () => {
  it("answers an empty result with no rows even without columns", () => {
    expect(declarativeRowsToResults({ columns: [], rows: [] })).toEqual([]);
  });
});

describe("PluginSearchCoordinator races", () => {
  it("answers cancelled, with no diagnostic, when the cancel lands as the answer resolves", async () => {
    registerSearchProviders("acme.notes", [provider()]);
    // Rows the switcher would drop, answered synchronously, so the answer has
    // already landed when the cancel queued below runs and only the check made
    // after resuming can still see it.
    bindSearchProviderImpl("acme.notes.notes", () => [{ id: "", label: "" }]);
    const search = coordinator();
    const view = endpoint();
    const result = search.query(view, "p1", {
      providerKey: "acme.notes.notes",
      query: "x",
      mode: "blended",
    });
    queueMicrotask(() => search.cancel(view.endpointId));
    expect(await result).toEqual({ status: "cancelled" });
    expect(diagnostics).toEqual([]);
  });

  it("reports a deadline that passed before the user typed on as a timeout", async () => {
    vi.useFakeTimers();
    registerSearchProviders("acme.notes", [provider()]);
    bindSearchProviderImpl("acme.notes.notes", () => new Promise(() => {}));
    const search = coordinator({ deadlineMs: 1000 });
    const view = endpoint();
    const result = search.query(view, "p1", {
      providerKey: "acme.notes.notes",
      query: "x",
      mode: "blended",
    });
    vi.advanceTimersByTime(1000);
    search.cancel(view.endpointId);
    await vi.runAllTimersAsync();
    expect(await result).toEqual({ status: "timeout" });
  });

  it("drops an answer for a provider switched off while it was answering", async () => {
    registerSearchProviders("acme.notes", [provider()]);
    const pending = deferred<{ id: string; label: string }[]>();
    bindSearchProviderImpl("acme.notes.notes", () => pending.promise);
    const result = coordinator().query(endpoint(), "p1", {
      providerKey: "acme.notes.notes",
      query: "x",
      mode: "blended",
    });
    hidden.add("acme.notes.notes");
    pending.resolve([{ id: "n1", label: "Groceries" }]);
    expect(await result).toEqual({ status: "unavailable" });
  });

  it("keeps a rebinding of the same function when the first binding's disposer runs", async () => {
    registerSearchProviders("acme.notes", [provider()]);
    const impl = vi.fn(() => [{ id: "n1", label: "Groceries" }]);
    const disposeFirst = bindSearchProviderImpl("acme.notes.notes", impl);
    bindSearchProviderImpl("acme.notes.notes", impl);
    disposeFirst();
    const result = await coordinator().query(endpoint(), "p1", {
      providerKey: "acme.notes.notes",
      query: "x",
      mode: "blended",
    });
    expect(result.status).toBe("ok");
  });

  it("reports a provider whose keyword an earlier plugin's reload takes back", () => {
    registerSearchProviders("acme.notes", [provider({ keyword: "alpha" })]);
    registerSearchProviders("other.notes", [
      provider({ pluginId: "other.notes", pluginName: "Other Notes", keyword: "beta" }),
    ]);
    const collisions = registerSearchProviders("acme.notes", [provider({ keyword: "beta" })]);
    expect(collisions.map((c) => [c.provider.pluginId, c.takenBy.pluginId])).toEqual([
      ["other.notes", "acme.notes"],
    ]);
    // A real reload unloads first; keeping the keyword still reports nothing new.
    unregisterSearchProviders("acme.notes");
    expect(registerSearchProviders("acme.notes", [provider({ keyword: "beta" })])).toEqual([]);
  });

  it("reports a displacement in a project where the displaced provider still held the keyword", () => {
    projectOf.set("project__p2__acme.wiki", "p2");
    projectOf.set("project__p1__acme.tasks", "p1");
    registerSearchProviders("project__p2__acme.wiki", [
      provider({ pluginId: "project__p2__acme.wiki", pluginName: "Wiki", keyword: "alpha" }),
    ]);
    // Holds "beta" in p1 only.
    registerSearchProviders("project__p1__acme.tasks", [
      provider({ pluginId: "project__p1__acme.tasks", pluginName: "Tasks", keyword: "beta" }),
    ]);
    // Installed: refused in p1, but holds "beta" in p2.
    registerSearchProviders("other.notes", [
      provider({ pluginId: "other.notes", pluginName: "Other Notes", keyword: "beta" }),
    ]);

    const collisions = registerSearchProviders("project__p2__acme.wiki", [
      provider({ pluginId: "project__p2__acme.wiki", pluginName: "Wiki", keyword: "beta" }),
    ]);
    expect(collisions.map((c) => [c.provider.pluginId, c.takenBy.pluginId])).toEqual([
      ["other.notes", "project__p2__acme.wiki"],
    ]);
  });
});

describe("validateSearchResults hardening", () => {
  it("drops args whose toJSON turns them into something other than an object", () => {
    const { rows, dropped } = validateSearchResults(
      provider(),
      [{ id: "a", label: "A", args: { toJSON: () => [1, 2] } }],
      20
    );
    expect(rows).toEqual([]);
    expect(dropped).toBe(1);
  });

  it("drops a row that throws while being read, and keeps the rest", () => {
    const throwing = {
      id: "bad",
      get label(): string {
        throw new Error("boom");
      },
    };
    const { rows, dropped } = validateSearchResults(
      provider(),
      [throwing, { id: "ok", label: "OK" }],
      20
    );
    expect(rows.map((row) => row.id)).toEqual(["ok"]);
    expect(dropped).toBe(1);
  });
});
