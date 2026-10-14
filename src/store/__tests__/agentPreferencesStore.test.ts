// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clientMock = vi.hoisted(() => ({
  set: vi.fn<(patch: Record<string, unknown>) => Promise<Record<string, unknown>>>(),
}));

vi.mock("@/clients/agentDefaultsClient", () => ({ agentDefaultsClient: clientMock }));
vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

describe("agentPreferencesStore (host mirror, #13345)", () => {
  beforeEach(() => {
    vi.resetModules();
    clientMock.set.mockReset();
    clientMock.set.mockResolvedValue({});
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  async function loadStore() {
    return (await import("../agentPreferencesStore")).useAgentPreferencesStore;
  }

  it("ignores this machine's localStorage — the default is the host's", async () => {
    localStorage.setItem(
      "daintree-agent-preferences",
      JSON.stringify({ state: { defaultAgent: "claude" }, version: 0 })
    );
    const store = await loadStore();

    expect(store.getState().defaultAgent).toBeUndefined();
  });

  it("saves a choice on the host and never writes localStorage", async () => {
    const store = await loadStore();

    await store.getState().setDefaultAgent("codex");

    expect(store.getState().defaultAgent).toBe("codex");
    expect(clientMock.set).toHaveBeenCalledWith({ defaultAgent: "codex" });
    expect(localStorage.getItem("daintree-agent-preferences")).toBeNull();
  });

  it("sends a cleared default as an explicit null", async () => {
    const store = await loadStore();

    await store.getState().setDefaultAgent(undefined);

    expect(clientMock.set).toHaveBeenCalledWith({ defaultAgent: null });
  });

  it("rolls a failed save back to the previous value", async () => {
    const store = await loadStore();
    store.getState().applyHostDefaultAgent("claude");
    clientMock.set.mockRejectedValueOnce(new Error("link down"));

    await store.getState().setDefaultAgent("codex");

    expect(store.getState().defaultAgent).toBe("claude");
  });

  it("doesn't let an older failed save undo a newer choice", async () => {
    const store = await loadStore();
    let rejectFirst: (error: Error) => void = () => {};
    clientMock.set.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (rejectFirst = reject))
    );

    const first = store.getState().setDefaultAgent("codex");
    await store.getState().setDefaultAgent("gemini");
    rejectFirst(new Error("link down"));
    await first;

    expect(store.getState().defaultAgent).toBe("gemini");
  });

  it("mirrors the host without writing back", async () => {
    const store = await loadStore();

    store.getState().applyHostDefaultAgent("codex");
    expect(store.getState().defaultAgent).toBe("codex");
    store.getState().applyHostDefaultAgent(null);
    expect(store.getState().defaultAgent).toBeUndefined();

    expect(clientMock.set).not.toHaveBeenCalled();
  });
});
