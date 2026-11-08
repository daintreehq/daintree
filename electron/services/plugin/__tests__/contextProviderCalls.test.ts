import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const issueProvider = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock("../../issueContextProvider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../issueContextProvider.js")>();
  return { ...actual, createIssueContextProvider: issueProvider.create };
});
import {
  CONTEXT_RESOLVE_TIMEOUT_MS,
  resolveContextReferences,
  searchContextProvider,
  type ContextProviderCallHost,
} from "../contextProviderCalls.js";
import {
  clearContextProviderImplRegistry,
  registerContextProviderImpl,
} from "../../contextProviderRegistry.js";
import type {
  ContextProviderEntry,
  ContextProviderImpl,
} from "../../../../shared/types/pluginContextProvider.js";
import { ISSUE_CONTEXT_PLUGIN_ID, ISSUE_CONTEXT_PROVIDER_ID } from "../../issueContextProvider.js";

function entry(overrides: Partial<ContextProviderEntry> = {}): ContextProviderEntry {
  return {
    pluginId: "acme.kanban",
    pluginName: "Kanban",
    providerId: "cards",
    prefix: "rec",
    label: "Cards",
    scope: "global",
    status: "active",
    ...overrides,
  };
}

function host(entries: ContextProviderEntry[]): ContextProviderCallHost & {
  activatePlugin: ReturnType<typeof vi.fn>;
  waitForCatalog: ReturnType<typeof vi.fn>;
} {
  return {
    getContextProvidersForProject: vi.fn(() => entries),
    activatePlugin: vi.fn(async () => {}),
    waitForCatalog: vi.fn(async () => {}),
  };
}

function bind(impl: Partial<ContextProviderImpl>, pluginId = "acme.kanban", providerId = "cards") {
  const full: ContextProviderImpl = {
    search: vi.fn(async () => []),
    resolve: vi.fn(async () => null),
    ...impl,
  };
  registerContextProviderImpl(pluginId, providerId, full);
  return full;
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  clearContextProviderImplRegistry();
  issueProvider.create.mockReset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("searchContextProvider (#13795)", () => {
  it("starts the holder's plugin and hands it only the query", async () => {
    const h = host([entry()]);
    const impl = bind({ search: vi.fn(async () => [{ id: "1", label: "Fix\nlogin" }]) });
    const result = await searchContextProvider(h, "p1", "rec", "fix");
    expect(h.activatePlugin).toHaveBeenCalledWith("acme.kanban");
    expect(impl.search).toHaveBeenCalledWith("fix", { signal: expect.any(AbortSignal) });
    expect(result).toEqual([{ id: "1", label: "Fix login" }]);
  });

  it("asks nobody for a prefix no active provider holds", async () => {
    const impl = bind({});
    const refused = host([entry({ status: "refused" })]);
    expect(await searchContextProvider(refused, "p1", "rec", "x")).toEqual([]);
    expect(await searchContextProvider(refused, "p1", "diff", "x")).toEqual([]);
    expect(impl.search).not.toHaveBeenCalled();
  });
});

describe("resolveContextReferences (#13795)", () => {
  it("answers in the order asked, once per distinct reference, in parallel", async () => {
    const h = host([entry(), entry({ pluginId: "acme.wiki", pluginName: "Wiki", prefix: "page" })]);
    const cards = bind({ resolve: vi.fn(async (id: string) => ({ text: `card ${id}` })) });
    bind({ resolve: vi.fn(async () => ({ text: "page", title: "Home" })) }, "acme.wiki");
    const results = await resolveContextReferences(h, "p1", [
      { prefix: "rec", id: "1" },
      { prefix: "page", id: "home" },
      { prefix: "rec", id: "1" },
      { prefix: "nope", id: "1" },
      { prefix: "rec", id: "bad id" },
    ]);
    expect(results).toEqual([
      { status: "resolved", pluginId: "acme.kanban", pluginName: "Kanban", text: "card 1" },
      {
        status: "resolved",
        pluginId: "acme.wiki",
        pluginName: "Wiki",
        text: "page",
        title: "Home",
      },
      { status: "resolved", pluginId: "acme.kanban", pluginName: "Kanban", text: "card 1" },
      { status: "unknown" },
      { status: "unknown" },
    ]);
    expect(cards.resolve).toHaveBeenCalledTimes(1);
  });

  it("fails a switched-off provider's reference rather than sending it as typed", async () => {
    const h = host([entry({ status: "off" })]);
    const impl = bind({});
    const [result] = await resolveContextReferences(h, "p1", [{ prefix: "rec", id: "1" }]);
    expect(result).toMatchObject({ status: "failed", pluginName: "Kanban" });
    expect(impl.resolve).not.toHaveBeenCalled();
  });

  it("gives up at the deadline, aborts the provider's signal, and says it timed out", async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    bind({
      resolve: vi.fn((_id: string, { signal }: { signal: AbortSignal }) => {
        seen = signal;
        return new Promise<never>(() => {});
      }),
    });
    const pending = resolveContextReferences(host([entry()]), "p1", [{ prefix: "rec", id: "1" }]);
    await vi.advanceTimersByTimeAsync(CONTEXT_RESOLVE_TIMEOUT_MS);
    const [result] = await pending;
    expect(result).toMatchObject({ status: "failed", reason: "timed out" });
    expect(seen?.aborted).toBe(true);
  });

  it("counts a plugin that never starts against the same deadline", async () => {
    vi.useFakeTimers();
    const h = host([entry()]);
    h.activatePlugin.mockImplementation(() => new Promise<never>(() => {}));
    const pending = resolveContextReferences(h, "p1", [{ prefix: "rec", id: "1" }]);
    await vi.advanceTimersByTimeAsync(CONTEXT_RESOLVE_TIMEOUT_MS);
    expect((await pending)[0]).toMatchObject({ status: "failed" });
  });

  it("spends one deadline across startup loading and the provider's answer", async () => {
    vi.useFakeTimers();
    const h = host([entry()]);
    let ready!: () => void;
    h.waitForCatalog.mockReturnValue(new Promise<void>((resolve) => (ready = resolve)));
    bind({
      resolve: vi.fn(() => new Promise<never>(() => {})),
    });
    const pending = resolveContextReferences(h, "p1", [{ prefix: "rec", id: "1" }]);
    await vi.advanceTimersByTimeAsync(4_000);
    ready();
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await pending)[0]).toMatchObject({ status: "failed", reason: "timed out" });
  });

  it("fails a held reference past the read limit instead of sending it as typed", async () => {
    const h = host([entry()]);
    bind({ resolve: vi.fn(async (id: string) => ({ text: id })) });
    const references = [
      ...Array.from({ length: 1_000 }, (_, i) => ({ prefix: "nope", id: `n${i}` })),
      { prefix: "rec", id: "7" },
    ];
    const results = await resolveContextReferences(h, "p1", references);
    expect(results[1_000]).toMatchObject({ status: "failed", pluginName: "Kanban" });
  });

  it("reports a provider's error, a missing item and oversized content as failures", async () => {
    const h = host([entry()]);
    bind({
      resolve: vi.fn(async (id: string) => {
        if (id === "boom") throw new Error("database is locked");
        if (id === "big") return { text: "x".repeat(40_000) };
        return null;
      }),
    });
    const results = await resolveContextReferences(h, "p1", [
      { prefix: "rec", id: "boom" },
      { prefix: "rec", id: "gone" },
      { prefix: "rec", id: "big" },
    ]);
    expect(results.map((r) => (r.status === "failed" ? r.reason : r.status))).toEqual([
      "database is locked",
      "not found",
      "returned more than 32,768 characters",
    ]);
  });

  it("resolves at most twenty distinct references in one send", async () => {
    const h = host([entry()]);
    const impl = bind({ resolve: vi.fn(async (id: string) => ({ text: id })) });
    const references = Array.from({ length: 22 }, (_, i) => ({ prefix: "rec", id: `r${i}` }));
    const results = await resolveContextReferences(h, "p1", references);
    expect(impl.resolve).toHaveBeenCalledTimes(20);
    expect(results.slice(20).every((r) => r.status === "failed")).toBe(true);
  });
});

describe("the host's @issue: provider (#16382)", () => {
  const issueEntry = entry({
    pluginId: ISSUE_CONTEXT_PLUGIN_ID,
    pluginName: "Daintree",
    providerId: ISSUE_CONTEXT_PROVIDER_ID,
    prefix: "issue",
    label: "Issues",
  });

  it("answers for the asking project without starting any plugin", async () => {
    const impl: ContextProviderImpl = {
      search: vi.fn(async () => [{ id: "12", label: "#12 Fix login" }]),
      resolve: vi.fn(async () => ({ text: "issue text", title: "#12 Fix login" })),
    };
    issueProvider.create.mockReturnValue(impl);
    const h = host([issueEntry]);

    expect(await searchContextProvider(h, "p1", "issue", "fix")).toEqual([
      { id: "12", label: "#12 Fix login" },
    ]);
    const [result] = await resolveContextReferences(h, "p1", [{ prefix: "issue", id: "12" }]);

    expect(result).toEqual({
      status: "resolved",
      pluginId: ISSUE_CONTEXT_PLUGIN_ID,
      pluginName: "Daintree",
      text: "issue text",
      title: "#12 Fix login",
    });
    expect(issueProvider.create).toHaveBeenCalledWith("p1", { deadlineAt: expect.any(Number) });
    expect(h.activatePlugin).not.toHaveBeenCalled();
  });

  it("hands the provider the resolve deadline so its reads can stop in time", async () => {
    vi.useFakeTimers();
    issueProvider.create.mockReturnValue({ search: vi.fn(), resolve: vi.fn(async () => null) });
    const start = Date.now();
    await resolveContextReferences(host([issueEntry]), "p1", [{ prefix: "issue", id: "1" }]);
    const [, { deadlineAt }] = issueProvider.create.mock.calls[0]!;
    expect(deadlineAt).toBe(start + CONTEXT_RESOLVE_TIMEOUT_MS);
  });
});
