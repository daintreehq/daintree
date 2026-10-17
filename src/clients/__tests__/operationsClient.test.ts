import { afterEach, describe, expect, it, vi } from "vitest";
import { isRemoteBoundView, mintRemoteOperationId } from "../operationsClient";

vi.stubGlobal("window", {});

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
