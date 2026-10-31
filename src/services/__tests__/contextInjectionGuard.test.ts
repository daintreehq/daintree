import { beforeEach, describe, expect, it, vi } from "vitest";

type Panel = { id: string; kind?: string; isInputLocked?: boolean };
type PanelState = { panelsById: Record<string, Panel> };

const { panelStore, injectMock, cancelMock, instanceLocks } = vi.hoisted(() => {
  let state: PanelState = { panelsById: {} };
  const listeners = new Set<(next: PanelState, prev: PanelState) => void>();
  const panelStore = {
    getState: () => state,
    subscribe: (listener: (next: PanelState, prev: PanelState) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setPanels(panelsById: Record<string, Panel>) {
      const prev = state;
      state = { panelsById };
      for (const listener of [...listeners]) listener(state, prev);
    },
    listenerCount: () => listeners.size,
  };
  return {
    panelStore,
    injectMock: vi.fn(),
    cancelMock: vi.fn(async () => undefined),
    instanceLocks: new Map<string, boolean>(),
  };
});

vi.mock("@/store/panelStore", () => ({ usePanelStore: panelStore }));
vi.mock("@/clients", () => ({
  copyTreeClient: { injectToTerminal: injectMock, cancel: cancelMock },
}));
vi.mock("@/services/terminal/terminalInstanceServiceAccessor", () => ({
  peek: () => ({
    get: (id: string) => (instanceLocks.has(id) ? { isInputLocked: instanceLocks.get(id) } : null),
  }),
}));

import { UnactionableTargetError } from "@/services/actions/unactionableTarget";
import {
  INPUT_LOCKED_INJECTION_REFUSAL,
  injectContextUnlessLocked,
  isTerminalInputLocked,
} from "../contextInjectionGuard";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const request = { terminalId: "t-1", worktreeId: "wt-1" };

describe("contextInjectionGuard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    instanceLocks.clear();
    panelStore.setPanels({ "t-1": { id: "t-1" }, "t-2": { id: "t-2" } });
    injectMock.mockResolvedValue({ content: "", fileCount: 2 });
  });

  it.each([
    ["the panel's lock", () => panelStore.setPanels({ "t-1": { id: "t-1", isInputLocked: true } })],
    ["the instance's lock alone", () => instanceLocks.set("t-1", true)],
  ])("refuses a target held by %s before anything is generated", async (_label, lock) => {
    lock();

    const attempt = injectContextUnlessLocked(request);

    await expect(attempt).rejects.toBeInstanceOf(UnactionableTargetError);
    await expect(attempt).rejects.toThrow(INPUT_LOCKED_INJECTION_REFUSAL);
    expect(injectMock).not.toHaveBeenCalled();
  });

  it("reads only a panel the map owns, never one it inherits", () => {
    const inherited = Object.create({ "t-9": { id: "t-9", isInputLocked: true } }) as Record<
      string,
      Panel
    >;
    inherited["constructor"] = { id: "constructor", isInputLocked: true };
    panelStore.setPanels(inherited);

    expect(isTerminalInputLocked("t-9")).toBe(false);
    expect(isTerminalInputLocked("constructor")).toBe(true);
  });

  it("gives each run that has no id one of its own, and keeps one it was given", async () => {
    await injectContextUnlessLocked(request);
    await injectContextUnlessLocked(request);
    await injectContextUnlessLocked({ ...request, injectionId: "inj-given", source: "terminal" });

    const first = injectMock.mock.calls[0]?.[3];
    const second = injectMock.mock.calls[1]?.[3];
    expect(first).toEqual(expect.any(String));
    expect(second).toEqual(expect.any(String));
    expect(first).not.toBe(second);
    expect(injectMock.mock.calls[2]).toEqual([
      "t-1",
      "wt-1",
      undefined,
      "inj-given",
      "terminal",
      undefined,
    ]);
  });

  it("stops the run with the lock as its reason the moment the pane is locked", async () => {
    const reply = deferred<{ content: string; fileCount: number; error?: string }>();
    injectMock.mockReturnValue(reply.promise);

    const pending = injectContextUnlessLocked({ ...request, injectionId: "inj-1" });
    panelStore.setPanels({ "t-1": { id: "t-1", isInputLocked: true } });

    expect(cancelMock).toHaveBeenCalledWith("inj-1", "input-locked");
    reply.resolve({ content: "", fileCount: 0, error: "Injection stopped: locked" });
    await expect(pending).resolves.toMatchObject({ error: "Injection stopped: locked" });
  });

  it("sends that stop once, even if the pane is unlocked and locked again", async () => {
    const reply = deferred<{ content: string; fileCount: number }>();
    injectMock.mockReturnValue(reply.promise);

    const pending = injectContextUnlessLocked({ ...request, injectionId: "inj-1" });
    panelStore.setPanels({ "t-1": { id: "t-1", isInputLocked: true } });
    panelStore.setPanels({ "t-1": { id: "t-1", isInputLocked: false } });
    panelStore.setPanels({ "t-1": { id: "t-1", isInputLocked: true } });
    reply.resolve({ content: "", fileCount: 0 });
    await pending;

    expect(cancelMock).toHaveBeenCalledTimes(1);
  });

  it("leaves the run alone when another pane is locked", async () => {
    const reply = deferred<{ content: string; fileCount: number }>();
    injectMock.mockReturnValue(reply.promise);

    const pending = injectContextUnlessLocked(request);
    panelStore.setPanels({ "t-1": { id: "t-1" }, "t-2": { id: "t-2", isInputLocked: true } });
    reply.resolve({ content: "", fileCount: 2 });
    await pending;

    expect(cancelMock).not.toHaveBeenCalled();
  });

  it("stops watching the pane once the run succeeds", async () => {
    await expect(injectContextUnlessLocked(request)).resolves.toMatchObject({ fileCount: 2 });
    panelStore.setPanels({ "t-1": { id: "t-1", isInputLocked: true } });

    expect(panelStore.listenerCount()).toBe(0);
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it("passes on a call that rejects, and stops watching the pane", async () => {
    injectMock.mockRejectedValue(new Error("ipc gone"));

    await expect(injectContextUnlessLocked(request)).rejects.toThrow("ipc gone");
    panelStore.setPanels({ "t-1": { id: "t-1", isInputLocked: true } });

    expect(panelStore.listenerCount()).toBe(0);
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it("still reports the run's own result when the stop can't be sent", async () => {
    cancelMock.mockRejectedValueOnce(new Error("ipc gone"));
    const reply = deferred<{ content: string; fileCount: number; error?: string }>();
    injectMock.mockReturnValue(reply.promise);

    const pending = injectContextUnlessLocked(request);
    panelStore.setPanels({ "t-1": { id: "t-1", isInputLocked: true } });
    reply.resolve({ content: "", fileCount: 2 });

    await expect(pending).resolves.toMatchObject({ fileCount: 2 });
  });
});
