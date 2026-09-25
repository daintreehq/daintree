import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isRemoteBoundView,
  mintOperationId,
  mintRemoteOperationId,
  operationsClient,
} from "../operationsClient";

const operations = {
  getStatus: vi.fn(async () => ({ status: "unknown" })),
  list: vi.fn(async () => []),
  cancel: vi.fn(async () => true),
  onEvent: vi.fn(() => () => {}),
};

vi.stubGlobal("window", { electron: { operations } });

afterEach(() => vi.clearAllMocks());

describe("operationsClient", () => {
  it("mints a distinct uuid per operation", () => {
    const a = mintOperationId();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(mintOperationId()).not.toBe(a);
  });

  it("wraps ids into the namespace's payloads", async () => {
    await operationsClient.getStatus("op-1");
    await operationsClient.cancel("op-1");
    await operationsClient.list();
    await operationsClient.list("p1");

    expect(operations.getStatus).toHaveBeenCalledWith({ opId: "op-1" });
    expect(operations.cancel).toHaveBeenCalledWith({ opId: "op-1" });
    expect(operations.list).toHaveBeenNthCalledWith(1, {});
    expect(operations.list).toHaveBeenNthCalledWith(2, { projectId: "p1" });
  });
});

describe("mintRemoteOperationId", () => {
  afterEach(() => {
    delete (window as { __DAINTREE_HOST_ID__?: unknown }).__DAINTREE_HOST_ID__;
  });

  it("names nothing in a local view", () => {
    expect(isRemoteBoundView()).toBe(false);
    expect(mintRemoteOperationId()).toBeUndefined();
    window.__DAINTREE_HOST_ID__ = { id: "local" };
    expect(isRemoteBoundView()).toBe(false);
    expect(mintRemoteOperationId()).toBeUndefined();
  });

  it("mints an id in a view bound to another host", () => {
    window.__DAINTREE_HOST_ID__ = { id: "build-box" };
    expect(isRemoteBoundView()).toBe(true);
    expect(mintRemoteOperationId()).toMatch(/^[0-9a-f-]{36}$/);
  });
});
