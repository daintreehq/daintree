import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getMock, addMock, updateMock, removeMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  addMock: vi.fn(),
  updateMock: vi.fn(),
  removeMock: vi.fn(),
}));

vi.mock("@/clients/userAgentRegistryClient", () => ({
  userAgentRegistryClient: {
    get: getMock,
    add: addMock,
    update: updateMock,
    remove: removeMock,
  },
}));

import {
  cleanupUserAgentRegistryStore,
  useUserAgentRegistryStore,
} from "../userAgentRegistryStore";

describe("userAgentRegistryStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanupUserAgentRegistryStore();
  });

  afterEach(() => {
    cleanupUserAgentRegistryStore();
  });

  it("allows initialize retry after a failed initialization", async () => {
    getMock
      .mockRejectedValueOnce(new Error("first failure"))
      .mockResolvedValueOnce({ myAgent: { id: "myAgent", name: "My Agent" } });

    await useUserAgentRegistryStore.getState().initialize();
    const afterFailure = useUserAgentRegistryStore.getState();
    expect(afterFailure.isInitialized).toBe(false);
    expect(afterFailure.error).toContain("first failure");

    await useUserAgentRegistryStore.getState().initialize();

    const afterRetry = useUserAgentRegistryStore.getState();
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(afterRetry.isInitialized).toBe(true);
    expect(afterRetry.error).toBeNull();
    expect(afterRetry.registry).toEqual({ myAgent: { id: "myAgent", name: "My Agent" } });
  });

  it("cleanup resets the store to pre-initialized state", () => {
    useUserAgentRegistryStore.setState({
      registry: { test: { id: "test", name: "Test Agent" } as never },
      isLoading: false,
      error: "boom",
      isInitialized: true,
    });

    cleanupUserAgentRegistryStore();

    expect(useUserAgentRegistryStore.getState()).toMatchObject({
      registry: null,
      isLoading: true,
      error: null,
      isInitialized: false,
    });
  });
});
