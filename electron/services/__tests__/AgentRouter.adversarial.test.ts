import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registryMock = vi.hoisted(() => ({
  getEffectiveRegistry: vi.fn(),
  getEffectiveAgentConfig: vi.fn(),
}));

vi.mock("../../../shared/config/agentRegistry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../shared/config/agentRegistry.js")>();
  return {
    ...actual,
    getEffectiveRegistry: registryMock.getEffectiveRegistry,
    getEffectiveAgentConfig: registryMock.getEffectiveAgentConfig,
  };
});

import {
  AgentRouter,
  disposeAgentRouter,
  getAgentRouter,
  initializeAgentRouter,
} from "../AgentRouter.js";
import type { AgentAvailabilityStore } from "../AgentAvailabilityStore.js";
import type { AgentRoutingConfig } from "../../../shared/types/agentSettings.js";

type AgentState = "idle" | "working" | "waiting" | "completed" | "exited";

function fakeStore(): AgentAvailabilityStore & {
  _setState: (id: string, state: AgentState | undefined) => void;
  _setAvailable: (id: string, v: boolean) => void;
  _setLoad: (id: string, n: number) => void;
  _calls: { getState: number; isAvailable: number; getConcurrentTaskCount: number };
} {
  const state = new Map<string, AgentState>();
  const available = new Map<string, boolean>();
  const load = new Map<string, number>();
  const calls = { getState: 0, isAvailable: 0, getConcurrentTaskCount: 0 };
  const store = {
    getState(id: string): AgentState | undefined {
      calls.getState += 1;
      return state.get(id);
    },
    isAvailable(id: string): boolean {
      calls.isAvailable += 1;
      return available.get(id) ?? true;
    },
    getConcurrentTaskCount(id: string): number {
      calls.getConcurrentTaskCount += 1;
      return load.get(id) ?? 0;
    },
    _setState(id: string, s: AgentState | undefined) {
      if (s === undefined) state.delete(id);
      else state.set(id, s);
    },
    _setAvailable(id: string, v: boolean) {
      available.set(id, v);
    },
    _setLoad(id: string, n: number) {
      load.set(id, n);
    },
    _calls: calls,
  };
  return store as unknown as ReturnType<typeof fakeStore>;
}

const routing = (overrides: Partial<AgentRoutingConfig> = {}): AgentRoutingConfig => ({
  enabled: true,
  capabilities: ["javascript", "typescript"],
  domains: { frontend: 0.8 },
  maxConcurrent: 2,
  ...overrides,
});

describe("AgentRouter adversarial", () => {
  let randomSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    registryMock.getEffectiveRegistry.mockReturnValue({
      alpha: { routing: routing() },
      beta: { routing: routing({ domains: { frontend: 0.9 } }) },
    });
    registryMock.getEffectiveAgentConfig.mockImplementation((id: string) => {
      if (id === "alpha") return { routing: routing() };
      if (id === "beta") return { routing: routing({ domains: { frontend: 0.9 } }) };
      return null;
    });
  });

  afterEach(() => {
    randomSpy.mockRestore();
    disposeAgentRouter();
  });

  it("dispose then re-init consults only the new store, not the old one", async () => {
    const storeA = fakeStore();
    const storeB = fakeStore();
    initializeAgentRouter(storeA as unknown as AgentAvailabilityStore);
    await getAgentRouter().routeTask();
    expect(storeA._calls.getState).toBeGreaterThan(0);

    disposeAgentRouter();
    const callsABefore = { ...storeA._calls };
    initializeAgentRouter(storeB as unknown as AgentAvailabilityStore);
    await getAgentRouter().routeTask();

    expect(storeA._calls).toEqual(callsABefore);
    expect(storeB._calls.getState).toBeGreaterThan(0);
  });

  it("agent filtered out when working becomes routable only after state flips to idle", async () => {
    const store = fakeStore();
    store._setState("alpha", "working");
    store._setAvailable("alpha", false);
    store._setState("beta", "working");
    store._setAvailable("beta", false);
    const router = new AgentRouter(store as unknown as AgentAvailabilityStore);

    const first = await router.routeTask();
    expect(first).toBeNull();

    store._setState("alpha", "idle");
    store._setAvailable("alpha", true);

    const second = await router.routeTask();
    expect(second).toBe("alpha");
  });

  it("concurrent routeTask calls with mutating load remain internally consistent", async () => {
    const store = fakeStore();
    const router = new AgentRouter(store as unknown as AgentAvailabilityStore);

    const flip = async () => {
      const p = router.routeTask({ preferredDomains: ["frontend"] });
      store._setLoad("alpha", store.getConcurrentTaskCount("alpha") + 1);
      return p;
    };

    const results = await Promise.all([flip(), flip()]);
    for (const r of results) {
      expect(["alpha", "beta"]).toContain(r);
    }
  });

  it("getAgentRouting on unknown agent returns default config without touching the store", async () => {
    const store = fakeStore();
    const router = new AgentRouter(store as unknown as AgentAvailabilityStore);

    const config = router.getAgentRouting("ghost");

    expect(config).toBeDefined();
    expect(store._calls.getState).toBe(0);
    expect(store._calls.isAvailable).toBe(0);
  });

  it("agent known to the store but missing from the registry is ignored during filtering", async () => {
    const store = fakeStore();
    store._setState("ghost", "idle");
    store._setAvailable("ghost", true);
    const router = new AgentRouter(store as unknown as AgentAvailabilityStore);

    const scores = await router.scoreCandidates();
    const ids = scores.map((s) => s.agentId);

    expect(ids).not.toContain("ghost");
    expect(ids).toContain("alpha");
    expect(ids).toContain("beta");
  });

  it("disabled routing excludes an agent even with idle state and zero load", async () => {
    registryMock.getEffectiveRegistry.mockReturnValue({
      alpha: { routing: routing({ enabled: false }) },
      beta: { routing: routing() },
    });
    const store = fakeStore();
    const router = new AgentRouter(store as unknown as AgentAvailabilityStore);

    const result = await router.routeTask();
    expect(result).toBe("beta");
  });

  it("capability requirements are case-insensitive on both sides", async () => {
    registryMock.getEffectiveRegistry.mockReturnValue({
      alpha: { routing: routing({ capabilities: ["TypeScript"] }) },
    });
    const store = fakeStore();
    const router = new AgentRouter(store as unknown as AgentAvailabilityStore);

    const result = await router.routeTask({ requiredCapabilities: ["typescript"] });
    expect(result).toBe("alpha");
  });

  it("agent at exactly maxConcurrent is filtered out, not selected", async () => {
    registryMock.getEffectiveRegistry.mockReturnValue({
      alpha: { routing: routing({ maxConcurrent: 2 }) },
    });
    const store = fakeStore();
    store._setLoad("alpha", 2);
    const router = new AgentRouter(store as unknown as AgentAvailabilityStore);

    const result = await router.routeTask();
    expect(result).toBeNull();
  });
});
