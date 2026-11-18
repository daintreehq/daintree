// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { CloudHostsSnapshot } from "@shared/types/cloudHosts";

const { supported } = vi.hoisted(() => ({ supported: { value: true } }));
vi.mock("@/lib/remoteHosts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/remoteHosts")>()),
  isRemoteShellSupported: () => supported.value,
}));

import { _resetCloudHostsStateForTesting, useCloudHostsWhile } from "../cloudHostsState";

const EMPTY: CloudHostsSnapshot = { providers: [], accounts: [], hosts: [] };

function bridge() {
  let answer: (snapshot: CloudHostsSnapshot) => void = () => {};
  const getSnapshot = vi.fn(() => new Promise<CloudHostsSnapshot>((resolve) => (answer = resolve)));
  const onEvent = vi.fn(() => () => {});
  (window as unknown as { electron: unknown }).electron = {
    remoteHosts: { onEvent },
    cloudHosts: { getSnapshot },
  };
  return { getSnapshot, onEvent, answer: (snapshot: CloudHostsSnapshot) => answer(snapshot) };
}

describe("useCloudHostsWhile (#17360)", () => {
  beforeEach(() => {
    supported.value = true;
  });

  afterEach(() => {
    _resetCloudHostsStateForTesting();
    delete (window as unknown as { electron?: unknown }).electron;
  });

  it("starts no read and no listener while inactive", () => {
    const { getSnapshot, onEvent } = bridge();
    const { result } = renderHook(() => useCloudHostsWhile(false));
    expect(result.current.pending).toBe(false);
    expect(getSnapshot).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("is pending while the first read is on its way, and not once it lands", async () => {
    const { getSnapshot, answer } = bridge();
    const { result } = renderHook(() => useCloudHostsWhile(true));
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toBe(true);
    await act(async () => answer(EMPTY));
    expect(result.current).toMatchObject({ pending: false, loaded: true });
  });

  it("is never pending where Remote Hosts isn't supported or the bridge is missing", () => {
    supported.value = false;
    const { getSnapshot } = bridge();
    expect(renderHook(() => useCloudHostsWhile(true)).result.current.pending).toBe(false);
    expect(getSnapshot).not.toHaveBeenCalled();
    _resetCloudHostsStateForTesting();

    supported.value = true;
    (window as unknown as { electron: unknown }).electron = { remoteHosts: { onEvent: vi.fn() } };
    expect(renderHook(() => useCloudHostsWhile(true)).result.current.pending).toBe(false);
  });
});
