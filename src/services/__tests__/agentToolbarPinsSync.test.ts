// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentToolbarPinsSnapshot } from "@shared/types";

const bootMock = vi.hoisted(() => ({
  getSafeBootPromise: vi.fn(),
}));
vi.mock("@/lib/bootPromise", () => bootMock);

vi.mock("@/utils/logger", () => ({ logWarn: vi.fn(), logError: vi.fn() }));

const clientMock = vi.hoisted(() => {
  let listener: ((snapshot: AgentToolbarPinsSnapshot) => void) | null = null;
  return {
    get: vi.fn<() => Promise<AgentToolbarPinsSnapshot>>(),
    set: vi.fn<(agentId: string, pinned: boolean) => Promise<AgentToolbarPinsSnapshot>>(),
    onChanged: vi.fn((cb: (snapshot: AgentToolbarPinsSnapshot) => void) => {
      listener = cb;
      return () => {
        listener = null;
      };
    }),
    push: (snapshot: AgentToolbarPinsSnapshot) => listener?.(snapshot),
  };
});
vi.mock("@/clients/agentToolbarPinsClient", () => ({ agentToolbarPinsClient: clientMock }));

import { initAgentToolbarPinsSync } from "../agentToolbarPinsSync";
import {
  getPinnedAgents,
  selectLoadedAgentPins,
  useAgentToolbarPinsStore,
} from "@/store/agentToolbarPinsStore";

function boot(agentToolbarPins?: AgentToolbarPinsSnapshot) {
  bootMock.getSafeBootPromise.mockResolvedValue({ ok: true, result: { agentToolbarPins } });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

const pins = () => useAgentToolbarPinsStore.getState().pins;

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, "electron", {
    value: { agentToolbarPins: {} },
    configurable: true,
    writable: true,
  });
  useAgentToolbarPinsStore.setState({ pins: {}, revision: -1 });
});

describe("initAgentToolbarPinsSync (#14702)", () => {
  let dispose: () => void = () => {};

  afterEach(() => {
    dispose();
    dispose = () => {};
  });

  it("seeds from the boot payload without asking main again", async () => {
    boot({ pins: { claude: true }, revision: 3 });

    dispose = initAgentToolbarPinsSync();
    await settle();

    expect(pins()).toEqual({ claude: true });
    expect(clientMock.get).not.toHaveBeenCalled();
  });

  it("reads over IPC when the boot payload has none", async () => {
    boot(undefined);
    clientMock.get.mockResolvedValue({ pins: { gemini: false }, revision: 1 });

    dispose = initAgentToolbarPinsSync();
    await settle();

    expect(pins()).toEqual({ gemini: false });
  });

  it("takes every change main pushes, whichever view made it", async () => {
    boot({ pins: {}, revision: 0 });
    dispose = initAgentToolbarPinsSync();
    await settle();

    clientMock.push({ pins: { codex: true }, revision: 1 });

    expect(pins()).toEqual({ codex: true });
  });

  it("drops a boot payload that a push has already overtaken", async () => {
    let resolveBoot: (value: unknown) => void = () => {};
    bootMock.getSafeBootPromise.mockReturnValue(
      new Promise((resolve) => {
        resolveBoot = resolve;
      })
    );
    dispose = initAgentToolbarPinsSync();

    clientMock.push({ pins: { claude: false }, revision: 5 });
    resolveBoot({
      ok: true,
      result: { agentToolbarPins: { pins: { claude: true }, revision: 4 } },
    });
    await settle();

    expect(pins()).toEqual({ claude: false });
  });

  it("stops listening once disposed", async () => {
    boot({ pins: {}, revision: 0 });
    dispose = initAgentToolbarPinsSync();
    await settle();
    dispose();

    clientMock.push({ pins: { claude: true }, revision: 1 });

    expect(pins()).toEqual({});
  });
});

describe("agentToolbarPinsStore", () => {
  it("pins optimistically, then takes main's committed snapshot", async () => {
    useAgentToolbarPinsStore.setState({ pins: { claude: true }, revision: 2 });
    let resolveSet: (snapshot: AgentToolbarPinsSnapshot) => void = () => {};
    clientMock.set.mockReturnValue(
      new Promise((resolve) => {
        resolveSet = resolve;
      })
    );

    const pending = useAgentToolbarPinsStore.getState().setAgentPinned("gemini", true);
    expect(pins()).toEqual({ claude: true, gemini: true });
    expect(clientMock.set).toHaveBeenCalledWith("gemini", true);

    // Another view unpinned claude meanwhile; main's answer carries both.
    resolveSet({ pins: { claude: false, gemini: true }, revision: 4 });
    await pending;

    expect(useAgentToolbarPinsStore.getState()).toMatchObject({
      pins: { claude: false, gemini: true },
      revision: 4,
    });
  });

  it("on a failed write takes main's current pins rather than its own earlier copy", async () => {
    useAgentToolbarPinsStore.setState({ pins: { claude: true }, revision: 2 });
    clientMock.set.mockRejectedValue(new Error("IPC down"));
    clientMock.get.mockResolvedValue({ pins: { claude: true, codex: true }, revision: 3 });

    await expect(
      useAgentToolbarPinsStore.getState().setAgentPinned("gemini", true)
    ).rejects.toThrow("IPC down");

    expect(pins()).toEqual({ claude: true, codex: true });
  });

  it("rolls its own guess back when main can't be read either", async () => {
    useAgentToolbarPinsStore.setState({ pins: { claude: true }, revision: 2 });
    clientMock.set.mockRejectedValue(new Error("IPC down"));
    clientMock.get.mockRejectedValue(new Error("IPC down"));

    await expect(
      useAgentToolbarPinsStore.getState().setAgentPinned("gemini", true)
    ).rejects.toThrow("IPC down");

    expect(pins()).toEqual({ claude: true });
  });

  it("never lets an older snapshot replace a newer one", () => {
    const { applySnapshot } = useAgentToolbarPinsStore.getState();
    applySnapshot({ pins: { claude: true }, revision: 7 });
    applySnapshot({ pins: { claude: false }, revision: 6 });

    expect(pins()).toEqual({ claude: true });
  });

  it("reads unloaded pins as unknown, never as none", () => {
    expect(selectLoadedAgentPins(useAgentToolbarPinsStore.getState())).toBeNull();
    useAgentToolbarPinsStore.getState().applySnapshot({ pins: {}, revision: 0 });
    expect(selectLoadedAgentPins(useAgentToolbarPinsStore.getState())).toEqual({});
  });

  it("lists only the agents explicitly pinned", () => {
    useAgentToolbarPinsStore.setState({
      pins: { a: true, b: false, d: true },
      revision: 0,
    });
    expect(getPinnedAgents().sort()).toEqual(["a", "d"]);
  });
});
